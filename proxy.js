/**
 * ==============================================================================
 * PROXY INTERMEDIADOR COM ROTAÇÃO DINÂMICA DE IPv6 (CROSS-PLATFORM)
 * ==============================================================================
 * 
 * Funcionalidade:
 *  - Intermedeia requisições HTTP/HTTPS para qualquer API de destino.
 *  - Fornece um Painel Web Dashboard completo na raiz (/) para testar todas as rotas.
 *  - Aloca dinamicamente novos endereços IPv6 aleatórios a partir de um bloco /64.
 *  - Suporta até 15 requisições por endereço IPv6 antes de efetuar a rotação.
 *  - Totalmente compatível com Windows (PowerShell/netsh) e Linux (iproute2/ip).
 *  - Zero dependências externas (utiliza apenas módulos nativos do Node.js).
 * 
 * ==============================================================================
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, execFileSync } = require('child_process');
const { URL } = require('url');

// Identificação da plataforma
const IS_WINDOWS = process.platform === 'win32';
const IS_LINUX = process.platform === 'linux';

// Configurações do Servidor
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0'; // Permite conexões de qualquer IP (local ou rede externa)
const MAX_REQS_PER_IP = 15; // Quantidade de requisições que cada IPv6 processa antes de rotacionar

// Helper para pausas assíncronas
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fila de sincronização (Mutex) para operações de rede no Sistema Operacional.
 * Evita colisões caso múltiplas requisições tentem adicionar/remover IPs simultaneamente.
 */
let netLockQueue = Promise.resolve();
function withNetLock(fn) {
  const res = netLockQueue.then(fn);
  netLockQueue = res.catch(() => {});
  return res;
}

/**
 * Valida se o processo atual possui privilégios administrativos necessários
 * para manipular interfaces de rede (netsh no Windows, iproute2 no Linux).
 */
function isAdmin() {
  if (IS_WINDOWS) {
    try {
      execSync('net session', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  } else {
    // No Linux/Unix, root possui UID 0
    return process.getuid ? process.getuid() === 0 : false;
  }
}

/**
 * Executa comandos PowerShell no Windows de forma segura e sem carregar perfis.
 */
function powershell(command) {
  const stdout = execFileSync('powershell.exe', ['-NoProfile', '-Command', command], {
    encoding: 'utf-8',
    windowsHide: true,
  });
  return stdout.trim();
}

/**
 * Converte uma string de endereço IPv6 (mesmo compactada com '::')
 * para um BigInt nativo de 128 bits.
 */
function ipToBigInt(ip) {
  const clean = ip.split('%')[0].trim();
  const parts = clean.split('::');
  const left = parts[0] ? parts[0].split(':') : [];
  const right = parts.length > 1 && parts[1] ? parts[1].split(':') : [];

  const missing = 8 - (left.length + right.length);
  const middle = new Array(missing).fill('0');

  const full = [...left, ...middle, ...right].map((h) => h.padStart(4, '0'));
  return BigInt('0x' + full.join(''));
}

/**
 * Converte um BigInt de 128 bits de volta para uma representação em string IPv6.
 */
function bigIntToIPv6(bn) {
  const hex = bn.toString(16).padStart(32, '0');
  const groups = [];
  for (let i = 0; i < 32; i += 4) {
    groups.push(parseInt(hex.slice(i, i + 4), 16).toString(16));
  }
  return groups.join(':');
}

/**
 * Verifica se o endereço IPv6 é público e globalmente roteável (Global Unicast).
 * Descarta faixas Link-Local (fe80::), Unique Local (fc00::) e Multicast (ff00::).
 */
function isGlobalIPv6(bn) {
  const hex = bn.toString(16).padStart(32, '0');
  const firstHextet = parseInt(hex.substring(0, 4), 16);

  if ((firstHextet & 0xffc0) === 0xfe80) return false; // Link-local (fe80::/10)
  if ((firstHextet & 0xfe00) === 0xfc00) return false; // Unique Local (fc00::/7)
  if ((firstHextet & 0xff00) === 0xff00) return false; // Multicast (ff00::/8)

  return firstHextet >= 0x2000 && firstHextet <= 0x3fff; // Faixa Global 2000::/3
}

/**
 * Detecta a interface de rede ativa que possui rota padrão IPv6 (::/0)
 * e extrai o prefixo de sub-rede /64 associado.
 */
function detectarRede() {
  const MASK_64 = 0xffffffffffffffff0000000000000000n;

  if (IS_WINDOWS) {
    const script = `
      $routes = @(Get-NetRoute -AddressFamily IPv6 | Where-Object DestinationPrefix -eq '::/0' | Sort-Object RouteMetric)
      $ips = @(Get-NetIPAddress -AddressFamily IPv6 | Where-Object AddressState -eq 'Preferred')
      @{
          routes = @($routes | Select-Object InterfaceIndex)
          ips = @($ips | Select-Object IPAddress,PrefixLength,InterfaceIndex)
      } | ConvertTo-Json -Depth 5 -Compress
    `;

    const data = JSON.parse(powershell(script));
    const rawRoutes = Array.isArray(data.routes) ? data.routes : (data.routes ? [data.routes] : []);
    const rawIps = Array.isArray(data.ips) ? data.ips : (data.ips ? [data.ips] : []);

    const interfaces = new Set(rawRoutes.map((r) => Number(r.InterfaceIndex)));

    for (const item of rawIps) {
      const ipBn = ipToBigInt(item.IPAddress);
      const prefix = Number(item.PrefixLength);
      const idx = Number(item.InterfaceIndex);

      if (interfaces.has(idx) && isGlobalIPv6(ipBn) && prefix === 64) {
        return { interfaceId: idx, networkBase: ipBn & MASK_64 };
      }
    }
  } else if (IS_LINUX) {
    // 1. Encontra a interface da rota padrão default
    const routeOut = execFileSync('ip', ['-6', 'route', 'show', 'default'], { encoding: 'utf-8' });
    const devMatch = routeOut.match(/dev\s+([^\s]+)/);
    if (!devMatch) {
      throw new Error('Nenhuma rota padrão IPv6 encontrada no Linux (ip -6 route show default).');
    }
    const iface = devMatch[1];

    // 2. Extrai o IP global /64 associado a essa interface
    const addrOut = execFileSync('ip', ['-6', 'addr', 'show', 'dev', iface, 'scope', 'global'], { encoding: 'utf-8' });
    const lines = addrOut.split('\n');

    for (const line of lines) {
      const match = line.trim().match(/inet6\s+([0-9a-fA-F:]+)\/(\d+)/);
      if (match) {
        const ipStr = match[1];
        const prefix = parseInt(match[2], 10);
        const ipBn = ipToBigInt(ipStr);

        if (prefix === 64 && isGlobalIPv6(ipBn)) {
          return { interfaceId: iface, networkBase: ipBn & MASK_64 };
        }
      }
    }
  }

  throw new Error(`Nenhuma interface com IPv6 global /64 e rota padrão encontrada no ${os.type()}.`);
}

/**
 * Gera um novo endereço IPv6 aleatório mantendo o prefixo /64 da rede.
 */
function gerarIPv6(networkBase) {
  const randomBytes = crypto.randomBytes(8);
  const host = BigInt('0x' + randomBytes.toString('hex'));
  return bigIntToIPv6(networkBase | host);
}

/**
 * Adiciona um endereço IPv6 temporário na interface de rede do SO.
 */
function adicionarIPv6(interfaceId, ip) {
  return withNetLock(() => {
    if (IS_WINDOWS) {
      execFileSync('netsh', [
        'interface', 'ipv6', 'add', 'address',
        `interface=${interfaceId}`, `address=${ip}`,
        'store=active', 'skipassource=true'
      ], { stdio: 'pipe' });
    } else {
      // No Linux, 'nodad' pula a verificação DAD e disponibiliza o IP de imediato
      execFileSync('ip', ['-6', 'addr', 'add', `${ip}/64`, 'dev', String(interfaceId), 'nodad'], { stdio: 'pipe' });
    }
  });
}

/**
 * Remove o endereço IPv6 temporário da interface após o término de sua utilização.
 */
function removerIPv6(interfaceId, ip) {
  return withNetLock(() => {
    try {
      if (IS_WINDOWS) {
        execFileSync('netsh', [
          'interface', 'ipv6', 'delete', 'address',
          `interface=${interfaceId}`, `address=${ip}`,
          'store=active'
        ], { stdio: 'pipe' });
      } else {
        execFileSync('ip', ['-6', 'addr', 'del', `${ip}/64`, 'dev', String(interfaceId)], { stdio: 'pipe' });
      }
    } catch (e) {
      // Ignora silenciosamente caso o IP já tenha sido desalocado
    }
  });
}

/**
 * Aguarda até que o IPv6 novo seja registrado pelo kernel e esteja pronto para envio.
 */
async function aguardarIPv6(interfaceId, ip) {
  if (IS_WINDOWS) {
    for (let i = 0; i < 20; i++) {
      try {
        const result = powershell(
          `Get-NetIPAddress -AddressFamily IPv6 -IPAddress '${ip}' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty AddressState`
        );
        if (result.trim() === 'Preferred') {
          return;
        }
      } catch {}
      await sleep(350);
    }
    throw new Error('IPv6 não ficou disponível dentro do tempo limite no Windows');
  } else {
    // No Linux com nodad a ativação é imediata; apenas valida a ausência de 'tentative'
    for (let i = 0; i < 20; i++) {
      try {
        const out = execFileSync('ip', ['-6', 'addr', 'show', 'dev', String(interfaceId), 'to', ip], { encoding: 'utf-8' });
        if (out && !out.includes('tentative')) {
          return;
        }
      } catch {}
      await sleep(100);
    }
  }
}

/**
 * Gerenciador de Sessão e Lote de IPv6.
 * Mantém o mesmo IPv6 ativo por até 15 requisições antes de rotacionar.
 */
class IPv6SessionManager {
  constructor(interfaceId, networkBase, maxUses = 15) {
    this.interfaceId = interfaceId;
    this.networkBase = networkBase;
    this.maxUses = maxUses;

    this.currentLease = null;
    this.allActiveIps = new Set();
    this.mutex = Promise.resolve();
  }

  getStats() {
    return {
      interfaceId: this.interfaceId,
      networkBase: `${bigIntToIPv6(this.networkBase)}/64`,
      currentIp: this.currentLease ? this.currentLease.ip : 'Aguardando 1º request',
      uses: this.currentLease ? this.currentLease.uses : 0,
      maxUses: this.maxUses,
      platform: `${os.type()} (${process.platform})`
    };
  }

  /**
   * Obtém um IPv6 válido para a requisição atual.
   * Se o IP atual atingiu o limite de usos, cria um novo automaticamente.
   */
  async acquireLease() {
    let release;
    const lock = new Promise((res) => { release = res; });
    const prevMutex = this.mutex;
    this.mutex = (async () => {
      await prevMutex;
      await lock;
    })();

    await prevMutex;

    try {
      if (!this.currentLease || this.currentLease.uses >= this.maxUses) {
        if (this.currentLease) {
          console.log(`\n[ROTAÇÃO] IPv6 ${this.currentLease.ip} atingiu o limite de ${this.maxUses} requisições.`);
          this.currentLease.retired = true;
          this.checkRetireLease(this.currentLease);
        }

        const newIp = gerarIPv6(this.networkBase);
        console.log(`\n[NOVO IPv6] Configurando na placa de rede: ${newIp}`);
        await adicionarIPv6(this.interfaceId, newIp);
        await aguardarIPv6(this.interfaceId, newIp);

        this.allActiveIps.add(newIp);
        this.currentLease = {
          ip: newIp,
          uses: 0,
          inFlight: 0,
          retired: false,
        };
        console.log(`[NOVO IPv6] ${newIp} ativo e pronto para até ${this.maxUses} requisições!\n`);
      }

      this.currentLease.uses++;
      this.currentLease.inFlight++;

      return this.currentLease;
    } finally {
      release();
    }
  }

  /**
   * Notifica que uma requisição em andamento terminou de utilizar o IPv6.
   */
  releaseLease(lease) {
    lease.inFlight--;
    if (lease.retired && lease.inFlight === 0) {
      this.checkRetireLease(lease);
    }
  }

  /**
   * Remove o IPv6 da interface de rede somente quando ele estiver aposentado (retired)
   * e não houver mais nenhuma requisição em trânsito (inFlight === 0).
   */
  async checkRetireLease(lease) {
    if (lease.retired && lease.inFlight === 0 && this.allActiveIps.has(lease.ip)) {
      this.allActiveIps.delete(lease.ip);
      console.log(`[LIMPEZA] Removendo IPv6 inativo: ${lease.ip}`);
      await removerIPv6(this.interfaceId, lease.ip);
    }
  }

  /**
   * Limpa todos os IPs temporários alocados durante a execução do processo.
   */
  async cleanupAll() {
    console.log(`Limpando todos os IPv6 temporários ativos (${this.allActiveIps.size})...`);
    for (const ip of this.allActiveIps) {
      try {
        await removerIPv6(this.interfaceId, ip);
        console.log(`- ${ip} removido.`);
      } catch (e) {
        console.error(`- Erro ao remover ${ip}:`, e.message);
      }
    }
    this.allActiveIps.clear();
  }
}

/**
 * Extrai a URL de destino a partir da requisição recebida:
 * 1. Pelo Header HTTP 'X-Target-URL'
 * 2. Pelo parâmetro na Query '?url=https://...'
 * 3. Pelo caminho direto na URL '/https://...'
 */
function extractTargetUrl(req) {
  const fromHeader = req.headers['x-target-url'];
  if (fromHeader) return fromHeader;

  const dummyBase = `http://${req.headers.host || 'localhost'}`;
  const parsed = new URL(req.url, dummyBase);
  const fromQuery = parsed.searchParams.get('url');
  if (fromQuery) return fromQuery;

  const rawPath = req.url.slice(1);
  if (rawPath.startsWith('http://') || rawPath.startsWith('https://')) {
    return rawPath;
  }

  return null;
}

/**
 * Inicializa o servidor proxy intermediador.
 */
async function startServer() {
  if (!isAdmin()) {
    const adminMsg = IS_WINDOWS
      ? 'Execute o terminal/Node como Administrador no Windows.'
      : 'Execute com privilégios de root (sudo node proxy.js) no Linux.';
    throw new Error(adminMsg);
  }

  console.log(`Sistema operacional: ${os.type()} (${process.platform})`);
  console.log('Detectando interface de rede e prefixo IPv6...');
  const { interfaceId, networkBase } = detectarRede();

  const ipManager = new IPv6SessionManager(interfaceId, networkBase, MAX_REQS_PER_IP);

  // Limpeza automática ao encerrar o servidor (Ctrl + C ou término de processo)
  const gracefulShutdown = async () => {
    console.log('\nFinalizando servidor proxy...');
    await ipManager.cleanupAll();
    process.exit(0);
  };
  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);

  console.log('====================================================');
  console.log('   PROXY INTERMEDIADOR IPv6 ROTATIVO (CROSS-PLATFORM)');
  console.log('====================================================');
  console.log(`Interface            : ${interfaceId}`);
  console.log(`Rede IPv6 Base       : ${bigIntToIPv6(networkBase)}/64`);
  console.log(`Limite por IPv6      : ${MAX_REQS_PER_IP} requisições`);
  console.log('====================================================');

  const server = http.createServer(async (req, res) => {
    // Permite chamadas de qualquer origem (CORS totalmente liberado)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    // 1. Endpoint para Estatísticas em tempo real (consumido pelo Dashboard)
    if (req.method === 'GET' && req.url === '/api/proxy-stats') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(ipManager.getStats()));
    }

    // 2. Servir o Painel Web Dashboard ao acessar a raiz no navegador
    const isDashboardRoute = req.method === 'GET' && (req.url === '/' || req.url === '/dashboard');
    const hasProxyParam = req.headers['x-target-url'] || req.url.includes('?url=');

    if (isDashboardRoute && !hasProxyParam) {
      const dashboardPath = path.join(__dirname, 'dashboard.html');
      if (fs.existsSync(dashboardPath)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(fs.readFileSync(dashboardPath, 'utf-8'));
      }
    }

    // 3. Extrair a URL alvo para intermediação
    const targetUrlStr = extractTargetUrl(req);

    if (!targetUrlStr) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({
        status: false,
        mensagem: 'Defina a rota de destino desejada ou abra http://localhost:' + PORT + ' no navegador para acessar o Painel Web!',
        exemplos: {
          via_header: {
            header: 'X-Target-URL',
            valor: 'https://zone.api.br/api/V2/instagram?apikey=SUA_KEY&url=https://www.instagram.com/reels/Df-DeM8P4aI/'
          },
          via_query_param: `http://localhost:${PORT}/?url=https://zone.api.br/api/V2/instagram?apikey=SUA_KEY%26url=https://www.instagram.com/reels/Df-DeM8P4aI/`,
          via_caminho_direto: `http://localhost:${PORT}/https://zone.api.br/api/v2/chatgpt?text=oi&apikey=SUA_KEY`
        }
      }, null, 2));
    }

    let targetUrl;
    try {
      targetUrl = new URL(targetUrlStr);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ status: false, error: 'URL de destino informada é inválida.' }));
    }

    // Coleta o corpo da requisição caso seja POST / PUT / PATCH
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const bodyBuffer = Buffer.concat(chunks);

    const reqId = crypto.randomBytes(3).toString('hex');
    let lease = null;

    try {
      // Reserva o IPv6 da sessão ativa (ou rotaciona se completou 15 usos)
      lease = await ipManager.acquireLease();

      console.log(`[${reqId}] Req #${lease.uses}/${MAX_REQS_PER_IP} no IP ${lease.ip} -> [${req.method}] ${targetUrl.href}`);

      const clientModule = targetUrl.protocol === 'https:' ? https : http;

      // Repassa os headers originais adaptando o host para o destino
      const forwardedHeaders = { ...req.headers };
      delete forwardedHeaders['host'];
      delete forwardedHeaders['x-target-url'];
      forwardedHeaders['host'] = targetUrl.host;

      const proxyReq = clientModule.request(targetUrl, {
        method: req.method,
        headers: forwardedHeaders,
        localAddress: lease.ip, // Bind na interface de saída com o IPv6 temporário!
        timeout: 30000,
      }, (proxyRes) => {
        console.log(`[${reqId}] Resposta recebida da API: HTTP ${proxyRes.statusCode}`);
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      });

      proxyReq.on('timeout', () => {
        console.error(`[${reqId}] Timeout aguardando o destino.`);
        proxyReq.destroy(new Error('A rota de destino não respondeu dentro de 30 segundos'));
      });

      proxyReq.on('error', (err) => {
        console.error(`[${reqId}] Erro ao contatar rota:`, err.message);
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ status: false, error: 'Erro no destino', detalhes: err.message }));
        }
      });

      if (bodyBuffer.length > 0) {
        proxyReq.write(bodyBuffer);
      }
      proxyReq.end();

    } catch (err) {
      console.error(`[${reqId}] Erro no intermediador:`, err.message);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: false, error: err.message }));
      }
    } finally {
      if (lease) {
        ipManager.releaseLease(lease);
      }
    }
  });

  server.listen(PORT, HOST, () => {
    console.log(`Servidor Proxy Intermediador ativo em: http://localhost:${PORT}`);
    console.log(`Painel Web Dashboard disponível em  : http://localhost:${PORT}/`);
    console.log(`Pronto para intermediar até ${MAX_REQS_PER_IP} requisições por IPv6!\n`);
  });
}

startServer().catch((err) => {
  console.error('Falha ao inicializar proxy:', err.message || err);
});
