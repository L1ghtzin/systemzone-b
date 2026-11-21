# IPv6 Rotating Proxy & Web Dashboard 🌐

Proxy HTTP intermediador multiplataforma (**Windows e Linux**) que realiza rotação dinâmica de endereços IPv6 a partir de um bloco `/64`, acompanhado de um **Painel Web Dashboard** moderno e integrado para consumir qualquer rota da **SystemZone API** diretamente pelo navegador.

Cada IPv6 temporário é gerado matematicamente com 128-bits (`BigInt`), configurado na interface de rede, utilizado para processar até **15 requisições** em altíssima velocidade e desalocado automaticamente sem deixar resíduos.

---

## 🖥️ Painel Web Integrado (Dashboard)

Ao iniciar o servidor, basta abrir no seu navegador:

👉 **`http://localhost:3000/`** (ou `http://SEU_IP:3000/` pela rede/celular)

### Recursos do Painel:
* **Estatísticas ao Vivo:** Exibe em tempo real o IPv6 ativo no momento, a contagem de requisições do lote (`X / 15`), o prefixo `/64` detectado e o status da conexão.
* **Chave Global:** Campo único para definir sua `apikey` (padrão `freekey`), aplicada instantaneamente em todas as rotas.
* **Abas Prontas para Uso:**
  * 📸 **Instagram Downloader (`/api/V2/instagram`):** Baixa Posts, Reels e Carrosséis, com player de vídeo embutido no navegador e botão de download em alta definição!
  * 💬 **ChatGPT (`/api/v2/chatgpt`):** Chat interativo com a IA.
  * 🤖 **Copilot (`/api/copilot`):** Consultas ao Microsoft Copilot.
  * 🎵 **TikTok (`/api/v2/tiktok`):** Baixador de vídeos do TikTok.
  * ⚡ **Rota Livre (Custom):** Playground completo para disparar qualquer rota (GET, POST, PUT, DELETE) com headers e body personalizados.
* **Visualizador de Respostas:** Formatação JSON com destaque, tempo de resposta em milissegundos e botão de cópia com 1 clique.

---

## 🚀 Funcionalidades do Backend

- **Multiplataforma Nativo:** Funciona de forma transparente tanto em **Windows** (usando `netsh` e PowerShell) quanto em **Linux** (usando `iproute2` / `ip -6 addr`).
- **Zero Dependências Externas:** Escrito puramente com os módulos nativos do Node.js (`http`, `https`, `crypto`, `fs`, `child_process`).
- **Rotação por Lote (15 requisições por IP):** O primeiro request cria o IPv6 na interface e os 14 seguintes reutilizam o mesmo IP instantaneamente, eliminando latências de alocação. Na 16ª requisição, o IP é rotacionado de forma limpa.
- **Concorrência e Thread-Safety:** Possui fila interna de sincronização de rede (`withNetLock`) para evitar colisões no sistema operacional caso múltiplos requests cheguem simultaneamente.
- **Roteamento Flexível:** Aceita o destino via **Header HTTP**, **Query Parameter** ou **Caminho direto**.
- **CORS Totalmente Liberado:** Aceita chamadas diretas de navegadores, Postman, cURL, scripts Python, etc.
- **Limpeza Automática:** Se o processo for encerrado (`Ctrl + C`), todos os IPv6 temporários são desassociados da placa de rede.

---

## 📋 Pré-requisitos

1. **Node.js** v18+ instalado.
2. Conexão de internet com suporte a **IPv6 com bloco `/64` atribuído** (ou túnel Hurricane Electric TunnelBroker).
3. **Privilégios de Administrador / Root:**
   - **Windows:** Executar o terminal como **Administrador** (necessário para o `netsh`).
   - **Linux:** Executar com `sudo` (necessário para manipular rotas com `ip`).

---

## 💻 Como Executar o Servidor

### 1. Iniciar no Windows:
Abra o **PowerShell** ou **CMD** como Administrador e execute:
```powershell
node proxy.js
```

### 2. Iniciar no Linux (Debian, Ubuntu, CentOS, etc.):
```bash
sudo node proxy.js
```

O servidor detectará automaticamente sua interface de rede e a rede IPv6 global `/64`, iniciando na porta `3000`:
```text
====================================================
   PROXY INTERMEDIADOR IPv6 ROTATIVO (CROSS-PLATFORM)
====================================================
Interface            : wlan0 (ou Interface Index no Windows)
Rede IPv6 Base       : 2804:xxxx:xxxx:xxxx:0:0:0:0/64
Limite por IPv6      : 15 requisições
====================================================
Servidor Proxy Intermediador ativo em: http://localhost:3000
Painel Web Dashboard disponível em  : http://localhost:3000/
Pronto para intermediar até 15 requisições por IPv6!
```

---

## 📡 Chamadas via API / Linha de Comando

Além do Painel Web, você pode chamar o proxy programaticamente de qualquer aplicação:

### 1. Instagram Downloader
```bash
curl -H "X-Target-URL: https://zone.api.br/api/V2/instagram?apikey=freekey&url=https://www.instagram.com/reels/Df-DeM8P4aI/" http://localhost:3000
```

### 2. ChatGPT
```bash
curl -H "X-Target-URL: https://zone.api.br/api/v2/chatgpt?text=Qual+a+capital+da+França?&apikey=freekey" http://localhost:3000
```

### 3. Exemplo em Python (`requests`):
```python
import requests

url_destino = 'https://zone.api.br/api/V2/instagram?apikey=freekey&url=https://www.instagram.com/reels/Df-DeM8P4aI/'

resposta = requests.get(
    'http://localhost:3000',
    headers={'X-Target-URL': url_destino}
)

dados = resposta.json()
print("Link do vídeo:", dados['media'][0])
```

---

## ⚙️ Configurações

No topo do arquivo `proxy.js`, você pode personalizar as variáveis de ambiente:

```javascript
const PORT = process.env.PORT || 3000; // Porta onde o proxy escuta
const HOST = '0.0.0.0';                // Permite acesso pela rede local ou externa
const MAX_REQS_PER_IP = 15;            // Quantidade de requisições por IPv6 antes da rotação
```

---

## 📄 Licença

MIT License. Desenvolvido para uso com a SystemZone API.
