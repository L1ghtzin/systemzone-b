const http = require('http');
const https = require('https');
const crypto = require('crypto');
const os = require('os');
const { execSync, execFileSync } = require('child_process');
const { URL } = require('url');

const IS_WINDOWS = process.platform === 'win32';
const IS_LINUX = process.platform === 'linux';

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
const MAX_REQS_PER_IP = 15; // Cada IPv6 executa até 15 requisições antes de trocar

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Fila para sincronizar operações de rede no sistema operacional
let netLockQueue = Promise.resolve();
function withNetLock(fn) {
  const res = netLockQueue.then(fn);
  netLockQueue = res.catch(() => {});
  return res;
}

// 1. Verifica privilégio de administrador (Windows: net session | Linux: root UID 0)
function isAdmin() {
  if (IS_WINDOWS) {
    try {
      execSync('net session', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  } else {
    return process.getuid ? process.getuid() === 0 : false;
  }
}

function powershell(command) {
  const stdout = execFileSync('powershell.exe', ['-NoProfile', '-Command', command], {
    encoding: 'utf-8',
    windowsHide: true,
  });
  return stdout.trim();
}

// 2. Manipulação de IPv6 com BigInt (128 bits)
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

function bigIntToIPv6(bn) {
  const hex = bn.toString(16).padStart(32, '0');
  const groups = [];
  for (let i = 0; i < 32; i += 4) {
    groups.push(parseInt(hex.slice(i, i + 4), 16).toString(16));
  }
  return groups.join(':');
}

function isGlobalIPv6(bn) {
  const hex = bn.toString(16).padStart(32, '0');
  const firstHextet = parseInt(hex.substring(0, 4), 16);

  if ((firstHextet & 0xffc0) === 0xfe80) return false; // Link-local
  if ((firstHextet & 0xfe00) === 0xfc00) return false; // Unique local
  if ((firstHextet & 0xff00) === 0xff00) return false; // Multicast

  return firstHextet >= 0x2000 && firstHextet <= 0x3fff; // Global Unicast
}

// 3. Detecção de interface e rede IPv6 /64 (Windows & Linux)
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
    // 1. Descobrir interface da rota padrão IPv6
    const routeOut = execFileSync('ip', ['-6', 'route', 'show', 'default'], { encoding: 'utf-8' });
    const devMatch = routeOut.match(/dev\s+([^\s]+)/);
    if (!devMatch) {
      throw new Error('Nenhuma rota padrão IPv6 encontrada no Linux (ip -6 route show default).');
    }
    const iface = devMatch[1];

    // 2. Descobrir IP global /64 nessa interface
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

function gerarIPv6(networkBase) {
  const randomBytes = crypto.randomBytes(8);
  const host = BigInt('0x' + randomBytes.toString('hex'));
  return bigIntToIPv6(networkBase | host);
}

// 4. Operações de adição/remoção de IP multiplataforma
function adicionarIPv6(interfaceId, ip) {
  return withNetLock(() => {
    if (IS_WINDOWS) {
      execFileSync('netsh', [
        'interface', 'ipv6', 'add', 'address',
        `interface=${interfaceId}`, `address=${ip}`,
        'store=active', 'skipassource=true'
      ], { stdio: 'pipe' });
    } else {
      // Linux: adiciona com /64 e 'nodad' para ativação imediata
      execFileSync('ip', ['-6', 'addr', 'add', `${ip}/64`, 'dev', String(interfaceId), 'nodad'], { stdio: 'pipe' });
    }
  });
}

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
      // Ignora se já foi removido
    }
  });
}

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
    // No Linux com 'nodad', a disponibilidade é quase instantânea
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

// 5. Gerenciador de Sessão com Rotação a cada 15 requisições
class IPv6SessionManager {
  constructor(interfaceId, networkBase, maxUses = 15) {
    this.interfaceId = interfaceId;
    this.networkBase = networkBase;
    this.maxUses = maxUses;

    this.currentLease = null;
    this.allActiveIps = new Set();
    this.mutex = Promise.resolve();
  }

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
          console.log(`\n[ROTAÇÃO] IPv6 ${this.currentLease.ip} atingiu ${this.maxUses} requisições.`);
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

  releaseLease(lease) {
    lease.inFlight--;
    if (lease.retired && lease.inFlight === 0) {
      this.checkRetireLease(lease);
    }
  }

  async checkRetireLease(lease) {
    if (lease.retired && lease.inFlight === 0 && this.allActiveIps.has(lease.ip)) {
      this.allActiveIps.delete(lease.ip);
      console.log(`[LIMPEZA] Removendo IPv6 inativo: ${lease.ip}`);
      await removerIPv6(this.interfaceId, lease.ip);
    }
  }

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

// 6. Extrai a URL de destino da requisição
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

  // Limpeza automática ao encerrar (Ctrl+C / SIGINT / SIGTERM)
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
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    const targetUrlStr = extractTargetUrl(req);

    if (!targetUrlStr) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        status: false,
        message: 'Defina a rota de destino!',
        exemplo_header: { 'X-Target-URL': 'https://zone.api.br/api/copilot?text=oi&apikey=freekey' },
        exemplo_query: `http://localhost:${PORT}/?url=https://zone.api.br/api/copilot?text=oi&apikey=freekey`
      }, null, 2));
    }

    let targetUrl;
    try {
      targetUrl = new URL(targetUrlStr);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: false, error: 'URL de destino inválida.' }));
    }

    // Coleta o corpo se houver (POST / PUT / PATCH)
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const bodyBuffer = Buffer.concat(chunks);

    const reqId = crypto.randomBytes(3).toString('hex');
    let lease = null;

    try {
      lease = await ipManager.acquireLease();

      console.log(`[${reqId}] Req #${lease.uses}/${MAX_REQS_PER_IP} no IP ${lease.ip} -> [${req.method}] ${targetUrl.href}`);

      const clientModule = targetUrl.protocol === 'https:' ? https : http;

      const forwardedHeaders = { ...req.headers };
      delete forwardedHeaders['host'];
      delete forwardedHeaders['x-target-url'];
      forwardedHeaders['host'] = targetUrl.host;

      const proxyReq = clientModule.request(targetUrl, {
        method: req.method,
        headers: forwardedHeaders,
        localAddress: lease.ip, // Bind na interface com o IPv6 temporário
        timeout: 30000,
      }, (proxyRes) => {
        console.log(`[${reqId}] Resposta recebida: HTTP ${proxyRes.statusCode}`);
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      });

      proxyReq.on('timeout', () => {
        console.error(`[${reqId}] Timeout no destino.`);
        proxyReq.destroy(new Error('Destino não respondeu em 30 segundos'));
      });

      proxyReq.on('error', (err) => {
        console.error(`[${reqId}] Erro ao contatar rota:`, err.message);
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: false, error: 'Erro no destino', details: err.message }));
        }
      });

      if (bodyBuffer.length > 0) {
        proxyReq.write(bodyBuffer);
      }
      proxyReq.end();

    } catch (err) {
      console.error(`[${reqId}] Erro no intermediador:`, err.message);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
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
    console.log(`Pronto para intermediar até ${MAX_REQS_PER_IP} requisições por IPv6!\n`);
  });
}

startServer().catch((err) => {
  console.error('Falha ao inicializar proxy:', err.message || err);
});
