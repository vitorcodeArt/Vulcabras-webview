# 🛍️ Catálogo de Produtos Mizuno - Documentação Completa

## ✅ O Que Foi Implementado

### 1. **Página de Catálogo Responsiva**

- URL: `http://localhost:3000/catalog`
- Interface limpa com Tailwind CSS + Bootstrap 5
- Suporte completo para mobile, tablet e desktop

### 2. **Sistema de Categorias**

Botões de seleção para:

- 🧔 Masculino (categoryId: 3)
- 👩 Feminino (categoryId: 4)
- 👶 Kids (categoryId: 5)
- ⚽ Esportes (categoryId: 6)
- 👟 Calçados (categoryId: 2)

### 3. **Carrossel de Produtos (Swiper.js)**

- Visualização fluida de produtos
- Navegação com setas e paginação
- Responsivo em todos os tamanhos
- Dados exibidos:
  - Imagem do produto
  - Nome
  - Marca
  - Botão "Mais Informações"

### 4. **Detalhes Completos do Produto**

Ao clicar em "Mais Informações":

- ✅ **5 Imagens** do produto (máximo) com miniaturas interativas
- ✅ **Descrição completa** do produto
- ✅ **Marca** e **nome**
- ✅ **Seletores de Variação**:
  - Dropdown de tamanho (com ordenação numérica)
  - Dropdown de cor (atualizado dinamicamente)
- ✅ **Link direto do carrinho** VTEX (único para cada variação)
- ✅ **Preview da seleção** (resumo visual antes de adicionar)

### 5. **Endpoints Backend (Proxy Seguro)**

#### GET `/api/catalog/categories`

```json
{
  "success": true,
  "categories": [
    { "id": "1", "name": "Masculino", "categoryId": "3" },
    ...
  ]
}
```

#### GET `/api/catalog/products?categoryId=3`

```json
{
  "success": true,
  "products": [
    {
      "productId": "8900",
      "name": "Tênis Casual Mizuno Cool Ride 3 Infantil",
      "brand": "Mizuno",
      "metaTagDescription": "...",
      "image": "https://..."
    },
    ...
  ]
}
```

#### GET `/api/catalog/product-details?productId=8900`

```json
{
  "success": true,
  "productId": "8900",
  "name": "Tênis Casual Mizuno Cool Ride 3 Infantil",
  "brand": "Mizuno",
  "description": "...",
  "images": [
    { "url": "https://...", "text": "Imagem 1" },
    ...
  ],
  "variations": [
    {
      "sku": "47380",
      "name": "Tênis Casual Mizuno Cool Ride 3 Infantil",
      "addToCartLink": "https://mizunobr.vtexcommercestable.com.br/checkout/cart/add?sku=47380&..."
    },
    ...
  ]
}
```

---

## 📁 Estrutura de Arquivos

```
public/
├── pages/
│   └── catalog.html          # Página principal
│       - Header com logo
│       - Seção de categorias
│       - Carrossel de produtos (Swiper)
│       - Detalhes do produto
│       - Seletores de variação
│       - Botão "Adicionar ao Carrinho"
│
├── css/
│   └── catalog.css           # Estilos customizados
│       - Botões de categoria
│       - Cards de produto
│       - Customizações do Swiper
│       - Miniaturas de imagens
│       - Responsividade
│
└── js/
    └── catalog.js            # Lógica completa
        - Estado da aplicação
        - Carregamento de categorias
        - Carregamento de produtos
        - Detalhes do produto
        - Tratamento de variações
        - Navegação entre telas
        - Utilitários (loading, erro)

server.js (Backend)
├── GET /catalog              # Serve a página HTML
├── GET /api/catalog/categories
├── GET /api/catalog/products
└── GET /api/catalog/product-details
```

---

## 🔐 Configuração de Credenciais

### .env (Desenvolvimento)

```env
VTEX_STORE_URL=mizunobr.vtexcommercestable.com.br
VTEX_API_KEY=vtexkey
VTEX_API_TOKEN=NZGMFKXVZDKYGZEKNFUFBFPIFJWDITJRYFUSIFFRNJNBXXLBONBLUNYZRRCEPGAQJOKTXCXMEQIROFLYYCUISDAUHGZWDVYUDKHQDKPZDJTSAKSUMRGIXVEJWXGLURJM
```

### .env.example (Repositório)

```env
VTEX_STORE_URL=sua-loja.vtexcommercestable.com.br
VTEX_API_KEY=sua_chave_vtex
VTEX_API_TOKEN=seu_token_vtex
```

**⚠️ Credenciais permanecem seguras no backend - Frontend nunca acessa direto à API VTEX**

---

## 🚀 Como Usar

### Iniciar o Servidor

```bash
npm install
npm start
```

O servidor inicia em `http://localhost:3000`

### Acessar o Catálogo

```
http://localhost:3000/catalog
```

### Fluxo de Navegação

1. Selecione uma categoria (ex: "Calçados")
2. Visualize o carrossel de produtos
3. Clique em "Mais Informações" de um produto
4. Veja as imagens (clique nas miniaturas para ampliar)
5. Selecione tamanho e cor nos dropdowns
6. Clique "Adicionar ao Carrinho"
7. Será redirecionado ao checkout VTEX com o produto/variação correto

---

## 📊 Tratamento de Variações

### Produtos com Tamanho + Cor

```
Exemplo: "39 Roxo", "39 Preto", "40 Roxo"

Dropdown 1 (Tamanho):
- 39
- 40

Dropdown 2 (Cor) - atualizado dinamicamente:
- Se tamanho = 39 → Roxo, Preto
- Se tamanho = 40 → Roxo

Link do carrinho é específico para cada combinação
```

### Produtos sem Variações

- Dropdown desabilitado
- Uma única opção "Única opção disponível"
- Link direto para o carrinho ativado

---

## 🎨 Paleta de Cores Utilizada

- **Primária**: Azul (#3b82f6)
- **Hover**: Azul mais claro (#2563eb)
- **Fundo**: Cinza claro (#f3f4f6)
- **Texto**: Cinza escuro (#1f2937)
- **Bordas**: Cinza (#e5e7eb)

---

## 📱 Responsividade

| Dispositivo | Breakpoint | Slides por Vez |
| ----------- | ---------- | -------------- |
| Mobile      | < 640px    | 1              |
| Tablet      | 640-1024px | 2              |
| Desktop     | > 1024px   | 3              |

---

## 🧪 Testes Rápidos

```bash
# Teste categorias
curl http://localhost:3000/api/catalog/categories

# Teste produtos de uma categoria
curl "http://localhost:3000/api/catalog/products?categoryId=3"

# Teste detalhes de um produto
curl "http://localhost:3000/api/catalog/product-details?productId=8900"
```

---

## ✨ Recursos Implementados

- ✅ Integração com API VTEX (Sunshine Conversations)
- ✅ Proxy seguro (credenciais no backend)
- ✅ Carrossel responsivo (Swiper.js)
- ✅ Seletores dinâmicos de tamanho/cor
- ✅ Miniaturas de imagens interativas
- ✅ Links diretos do carrinho por variação
- ✅ Tratamento de erros e loading
- ✅ Sem banco de dados
- ✅ Sem autenticação adicional
- ✅ Pronto para produção no Render

---

## 🔗 Integração com Bot Zendesk

Para usar dentro de um bot Zendesk (Ultimate):

```javascript
// No seu fluxo do bot, use:
const catalogUrl = "https://vulcabras-webview.onrender.com/catalog";

// Envie como webview
{
  "type": "webview",
  "text": "Ver Catálogo",
  "uri": catalogUrl
}
```

---

## 📝 Notas

- A aplicação é **stateless** - não armazena dados de sessão
- Cada requisição ao catálogo é independente
- As credenciais VTEX são carregadas do `.env` no servidor
- Suporta múltiplas categorias e produtos ilimitados da VTEX
- Pronto para ser embarcado em diferentes webviews do Zendesk

---

**Desenvolvido para integração com Zendesk Sunshine Conversations**
