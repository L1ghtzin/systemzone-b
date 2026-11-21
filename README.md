# IPv6 Rotating Proxy 🌐

Proxy HTTP intermediador multiplataforma (**Windows e Linux**) que realiza rotação dinâmica de endereços IPv6 a partir de um bloco `/64`.

Cada IPv6 temporário é gerado matematicamente com 128-bits (`BigInt`), adicionado à placa de rede, utilizado para processar até **15 requisições** em alta velocidade e desalocado automaticamente sem deixar rastros.

---

## 🚀 Funcionalidades

- **Multiplataforma Nativo:** Funciona de forma transparente tanto em **Windows** (usando `netsh` e PowerShell) quanto em **Linux** (usando `iproute2` / `ip -6 addr`).
- **Zero Dependências Externas:** Escrito puramente com os módulos nativos do Node.js (`http`, `https`, `crypto`, `child_process`).
- **Rotação por Lote (15 requisições por IP):** O primeiro request cria o IPv6 na interface e os 14 seguintes reutilizam o mesmo IP instantaneamente, eliminando latências de alocação. Na 16ª requisição, o IP é rotacionado de forma limpa.
- **Concorrência e Thread-Safety:** Possui fila interna de sincronização de rede (`withNetLock`) para evitar colisões no sistema operacional caso múltiplos requests cheguem simultaneamente.
- **Roteamento Flexível:** Aceita o destino via **Header HTTP**, **Query Parameter** ou **Caminho direto**.
- **CORS Liberado:** Aceita chamadas diretas de navegadores, Postman, cURL, scripts Python, etc.
- **Limpeza Automática:** Se o processo for encerrado (`Ctrl + C`), todos os IPv6 temporários são desassociados da placa de rede.

---

## 📋 Pré-requisitos

1. **Node.js** v18+ instalado.
2. Uma conexão de internet com suporte a **IPv6 com bloco `/64` atribuído** (comum na maioria dos provedores residenciais de fibra e VPS).
3. **Privilégios de Administrador / Root:**
   - **Windows:** Executar o terminal como **Administrador** (necessário para o `netsh`).
   - **Linux:** Executar com `sudo` (necessário para manipular rotas com `ip`).

---

## 💻 Como Executar

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
Interface            : eth0 (ou Interface Index no Windows)
Rede IPv6 Base       : 2804:xxxx:xxxx:xxxx:0:0:0:0/64
Limite por IPv6      : 15 requisições
====================================================
Servidor Proxy Intermediador ativo em: http://localhost:3000
Pronto para intermediar até 15 requisições por IPv6!
```

---

## 📡 Como Usar o Proxy

Você pode enviar requisições de qualquer linguagem ou ferramenta para o proxy informando a URL que deseja acessar.

### Opção 1: Via Header `X-Target-URL` (Recomendado)

#### Exemplo em cURL:
```bash
curl -H "X-Target-URL: https://api.ipify.org?format=json" http://localhost:3000
```

#### Exemplo em JavaScript (Node.js / Browser / Fetch):
```javascript
const response = await fetch('http://localhost:3000', {
  headers: {
    'X-Target-URL': 'https://api.ipify.org?format=json'
  }
});
const data = await response.json();
console.log(data);
```

#### Exemplo em Python (`requests`):
```python
import requests

res = requests.get(
    'http://localhost:3000',
    headers={'X-Target-URL': 'https://api.ipify.org?format=json'}
)
print(res.json())
```

---

### Opção 2: Via Query Param (`?url=...`)

Ideal para testes rápidos pelo navegador ou chamadas cURL simples:

```bash
curl "http://localhost:3000/?url=https://api.ipify.org?format=json"
```

---

### Opção 3: Via Caminho Direto

```bash
curl "http://localhost:3000/https://api.ipify.org?format=json"
```

---

## ⚙️ Configurações

No topo do arquivo `proxy.js`, você pode personalizar:

```javascript
const PORT = process.env.PORT || 3000; // Porta do servidor intermediador
const HOST = '0.0.0.0';                // Permite acesso de outros dispositivos na rede
const MAX_REQS_PER_IP = 15;            // Quantidade de requisições antes de rotacionar o IPv6
```

---

## 📄 Licença

MIT License. Sinta-se livre para usar e modificar.
