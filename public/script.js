const PORTAL_URL = 'https://ir-comercio-portal-zcan.onrender.com';
const API_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? 'http://localhost:3002/api'
    : `${window.location.origin}/api`;

let produtos = [];
let grupos = [];
let isOnline = false;
let grupoSelecionado = 'TODOS';
let lastDataHash = '';
let sessionToken = null;
let autoSyncEnabled = true;

// Variáveis para histórico
let currentHistoryType = 'entrada';
let currentHistoryPage = 1;
let historyData = { data: [], pagination: { totalPages: 1 } };

console.log('🚀 Estoque iniciado');
console.log('📍 API URL:', API_URL);

document.addEventListener('DOMContentLoaded', () => {
    verificarAutenticacao();
});

// Função de formatação monetária brasileira
function formatarMoeda(valor) {
    if (valor === null || valor === undefined || isNaN(valor)) {
        return 'R$ 0,00';
    }
    return valor.toLocaleString('pt-BR', {
        style: 'currency',
        currency: 'BRL',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}

function verificarAutenticacao() {
    const urlParams = new URLSearchParams(window.location.search);
    const tokenFromUrl = urlParams.get('sessionToken');

    if (tokenFromUrl) {
        sessionToken = tokenFromUrl;
        sessionStorage.setItem('estoqueSession', tokenFromUrl);
        window.history.replaceState({}, document.title, window.location.pathname);
    } else {
        sessionToken = sessionStorage.getItem('estoqueSession');
    }

    if (!sessionToken) {
        mostrarTelaAcessoNegado();
        return;
    }

    inicializarApp();
}

function mostrarTelaAcessoNegado(mensagem = 'NÃO AUTORIZADO') {
    document.body.innerHTML = `
        <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; background: var(--bg-primary); color: var(--text-primary); text-align: center; padding: 2rem;">
            <h1 style="font-size: 2.2rem; margin-bottom: 1rem;">${mensagem}</h1>
            <p style="color: var(--text-secondary); margin-bottom: 2rem;">Somente usuários autenticados podem acessar esta área.</p>
            <a href="${PORTAL_URL}" style="display: inline-block; background: var(--btn-register); color: white; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: 600;">Ir para o Portal</a>
        </div>
    `;
}

async function inicializarApp() {
    await checkServerStatus();
    await loadGrupos();
    setInterval(checkServerStatus, 30000);
    setInterval(async () => {
        if (isOnline && autoSyncEnabled) {
            await loadProducts(true);
        }
    }, 60000);
}

async function checkServerStatus() {
    try {
        const headers = {
            'Accept': 'application/json'
        };
        
        if (sessionToken) {
            headers['X-Session-Token'] = sessionToken;
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        const response = await fetch(`${API_URL}/estoque`, {
            method: 'HEAD',
            headers: headers,
            mode: 'cors',
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (response.status === 401) {
            sessionStorage.removeItem('estoqueSession');
            mostrarTelaAcessoNegado('Sua sessão expirou');
            return false;
        }

        const wasOffline = !isOnline;
        isOnline = response.ok;
        
        if (wasOffline && isOnline) {
            console.log('✅ SERVIDOR ONLINE');
            await loadProducts();
        }
        
        updateConnectionStatus();
        return isOnline;
    } catch (error) {
        isOnline = false;
        updateConnectionStatus();
        return false;
    }
}

function updateConnectionStatus() {
    const status = document.getElementById('connectionStatus');
    if (status) {
        status.className = isOnline ? 'connection-status online' : 'connection-status offline';
    }
}

// ===== GRUPOS =====

async function loadGrupos() {
    if (!isOnline) return;
    
    try {
        const response = await fetch(`${API_URL}/grupos`, {
            headers: {
                'X-Session-Token': sessionToken,
                'Accept': 'application/json'
            }
        });

        if (response.status === 401) {
            sessionStorage.removeItem('estoqueSession');
            mostrarTelaAcessoNegado('Sua sessão expirou');
            return;
        }

        if (!response.ok) throw new Error('Erro ao carregar grupos');

        grupos = await response.json();
        renderGruposFilter();
        populateGrupoSelect();
    } catch (error) {
        console.error('Erro ao carregar grupos:', error);
    }
}

function renderGruposFilter() {
    const container = document.getElementById('gruposFilter');
    if (!container) return;

    container.innerHTML = '';

    const btnTodos = document.createElement('button');
    btnTodos.className = `brand-button ${grupoSelecionado === 'TODOS' ? 'active' : ''}`;
    btnTodos.textContent = 'TODOS';
    btnTodos.onclick = () => filtrarPorGrupo('TODOS');
    container.appendChild(btnTodos);

    grupos.forEach(grupo => {
        const btn = document.createElement('button');
        btn.className = `brand-button ${grupoSelecionado === grupo.id ? 'active' : ''}`;
        btn.textContent = grupo.nome;
        btn.onclick = () => filtrarPorGrupo(grupo.id);
        container.appendChild(btn);
    });
}

function populateGrupoSelect() {
    const select = document.getElementById('grupo');
    if (!select) return;

    select.innerHTML = '<option value="">Selecione um grupo</option>';
    
    grupos.forEach(grupo => {
        const option = document.createElement('option');
        option.value = grupo.id;
        option.textContent = grupo.nome;
        select.appendChild(option);
    });
}

function filtrarPorGrupo(grupoId) {
    grupoSelecionado = grupoId;
    renderGruposFilter();
    filterProducts();
}

window.openNewGroupModal = function() {
    document.getElementById('nomeGrupo').value = '';
    document.getElementById('newGroupModal').classList.add('show');
};

window.closeNewGroupModal = function() {
    document.getElementById('newGroupModal').classList.remove('show');
};

window.saveNewGroup = async function(event) {
    event.preventDefault();
    
    const nome = document.getElementById('nomeGrupo').value.trim();
    
    if (!nome) {
        showMessage('Nome do grupo é obrigatório', 'error');
        return;
    }

    try {
        const response = await fetch(`${API_URL}/grupos`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Session-Token': sessionToken
            },
            body: JSON.stringify({ nome })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Erro ao criar grupo');
        }

        const novoGrupo = await response.json();
        
        await loadGrupos();
        closeNewGroupModal();
        showMessage(`Grupo "${novoGrupo.nome}" criado com código ${novoGrupo.codigo}`, 'success');
        
        // Selecionar automaticamente o novo grupo no formulário
        const grupoSelect = document.getElementById('grupo');
        if (grupoSelect) {
            grupoSelect.value = novoGrupo.id;
        }
    } catch (error) {
        showMessage(error.message, 'error');
    }
};

// ===== PRODUTOS =====

async function loadProducts(silencioso = false) {
    if (!isOnline) return;
    
    try {
        const response = await fetch(`${API_URL}/estoque`, {
            headers: {
                'X-Session-Token': sessionToken,
                'Accept': 'application/json'
            }
        });

        if (response.status === 401) {
            sessionStorage.removeItem('estoqueSession');
            mostrarTelaAcessoNegado('Sua sessão expirou');
            return;
        }

        if (!response.ok) throw new Error('Erro ao carregar');

        const data = await response.json();
        
        const newHash = JSON.stringify(data.map(p => `${p.id}-${p.quantidade}`));
        
        if (newHash !== lastDataHash) {
            lastDataHash = newHash;
            produtos = data;
            
            filterProducts();
            
            if (!silencioso) {
                console.log(`📦 ${produtos.length} produtos carregados`);
            }
        }
    } catch (error) {
        console.error('Erro ao carregar produtos:', error);
        if (!silencioso) {
            showMessage('Erro ao carregar dados', 'error');
        }
    }
}

window.sincronizarManual = async function() {
    if (!isOnline) {
        showMessage('Sistema offline', 'error');
        return;
    }

    const btn = document.querySelector('.sync-btn:last-child');
    if (btn) {
        btn.style.pointerEvents = 'none';
        const svg = btn.querySelector('svg');
        svg.style.animation = 'spin 1s linear infinite';
    }

    try {
        await loadProducts();
        await loadGrupos(); // 🎯 ADICIONAR SINCRONIZAÇÃO DE GRUPOS
        showMessage('Dados atualizados', 'success');
    } finally {
        if (btn) {
            btn.style.pointerEvents = 'auto';
            const svg = btn.querySelector('svg');
            svg.style.animation = 'none';
        }
    }
};

function filterProducts() {
    const search = document.getElementById('search').value.toLowerCase();
    
    let filtered = produtos;

    if (grupoSelecionado !== 'TODOS') {
        filtered = filtered.filter(p => p.grupo_id === grupoSelecionado);
    }

    if (search) {
        filtered = filtered.filter(p =>
            p.codigo.toString().includes(search) ||
            p.codigo_fornecedor.toLowerCase().includes(search) ||
            p.marca.toLowerCase().includes(search) ||
            p.descricao.toLowerCase().includes(search)
        );
    }

    renderTable(filtered);
}

function renderTable(products) {
    const tbody = document.getElementById('estoqueTableBody');
    if (!tbody) return;

    if (products.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; padding: 2rem;">Nenhum produto encontrado</td></tr>';
        return;
    }

tbody.innerHTML = products.map(p => `
    <tr>
        <td><strong>${p.codigo}</strong></td>
        <td>${p.marca}</td>
        <td>${p.codigo_fornecedor}</td>
        <td>${p.descricao}</td>
        <td>${p.unidade || 'UN'}</td>
        <td><strong>${p.quantidade}</strong></td>
        <td>${formatarMoeda(parseFloat(p.valor_unitario))}</td>
        <td><strong>${formatarMoeda(p.quantidade * parseFloat(p.valor_unitario))}</strong></td>
        <td class="actions-cell">
            <button onclick="viewProduct('${p.id}')" class="action-btn view">Ver</button>
            <button onclick="editProduct('${p.id}')" class="action-btn edit">Editar</button>
            <button onclick="openEntradaModal('${p.id}')" class="action-btn success">Entrada</button>
            <button onclick="openSaidaModal('${p.id}')" class="action-btn delete">Saída</button>
        </td>
    </tr>
`).join('');
} // ✅ ADICIONAR ESTA CHAVE DE FECHAMENTO

// MODAL DE ABAS
let editingProductId = null;
let formCancelado = false;

window.switchTab = function(tabName) {
    document.querySelectorAll('.tab-button').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
    
    document.querySelector(`[onclick="switchTab('${tabName}')"]`).classList.add('active');
    document.getElementById(`tab-${tabName}`).classList.add('active');
};

window.toggleForm = function() {
    editingProductId = null;
    formCancelado = false;
    document.getElementById('formTitle').textContent = 'Novo Produto';
    document.getElementById('productForm').reset();
    
    // Reabilitar todos os campos
    document.getElementById('marca').disabled = false;
    document.getElementById('marca').required = true;
    document.getElementById('quantidade').disabled = false;
    document.getElementById('valor_unitario').disabled = false;
    document.getElementById('grupo').disabled = false;
    
    // Mostrar TODOS os campos
    document.getElementById('marcaField').style.display = 'block';
    document.getElementById('grupoField').style.display = 'block';
    document.getElementById('unidadeField').style.display = 'block';
    document.getElementById('quantidadeField').style.display = 'block';
    
    // Reativar required nos campos
    document.getElementById('grupo').required = true;
    document.getElementById('unidade').required = true;
    document.getElementById('quantidade').required = true;
    
    // Mostrar botão de adicionar grupo
    const btnAddGrupo = document.getElementById('btnAddGrupo');
    if (btnAddGrupo) {
        btnAddGrupo.style.display = 'flex';
    }
    
    switchTab('fornecedor');
    document.getElementById('formModal').classList.add('show');
};

window.closeFormModal = function(cancelado = false) {
    const modal = document.getElementById('formModal');
    modal.classList.remove('show');
    
    if (cancelado) {
        if (editingProductId) {
            showMessage('Atualização cancelada', 'error');
        } else {
            showMessage('Cadastro cancelado', 'error');
        }
    }
    
    editingProductId = null;
    formCancelado = false;
};

window.editProduct = async function(id) {
    const produto = produtos.find(p => p.id === id);
    if (!produto) return;

    editingProductId = id;
    formCancelado = false;
    document.getElementById('formTitle').textContent = 'Editar Produto';
    
    // Preencher campos editáveis
    document.getElementById('codigo_fornecedor').value = produto.codigo_fornecedor;
    document.getElementById('ncm').value = produto.ncm || '';
    document.getElementById('descricao').value = produto.descricao;
    
    // Valor unitário EDITÁVEL
    document.getElementById('valor_unitario').value = parseFloat(produto.valor_unitario).toFixed(2);
    document.getElementById('valor_unitario').disabled = false;
    
    // Preencher campos ocultos (para não perder dados)
    document.getElementById('marca').value = produto.marca;
    document.getElementById('unidade').value = produto.unidade || 'UN';
    document.getElementById('quantidade').value = produto.quantidade;
    document.getElementById('grupo').value = produto.grupo_id || '';
    
    // Remover required dos campos ocultos
    document.getElementById('marca').required = false;
    document.getElementById('grupo').required = false;
    document.getElementById('unidade').required = false;
    document.getElementById('quantidade').required = false;
    
    // OCULTAR campos não editáveis
    document.getElementById('marcaField').style.display = 'none';
    document.getElementById('grupoField').style.display = 'none';
    document.getElementById('unidadeField').style.display = 'none';
    document.getElementById('quantidadeField').style.display = 'none';
    
    // Ocultar botão de adicionar grupo
    const btnAddGrupo = document.getElementById('btnAddGrupo');
    if (btnAddGrupo) {
        btnAddGrupo.style.display = 'none';
    }
    
    switchTab('fornecedor');
    document.getElementById('formModal').classList.add('show');
};

window.saveProduct = async function(event) {
    event.preventDefault();

    let formData;
    
    if (editingProductId) {
        // MODO EDIÇÃO: apenas campos editáveis
        formData = {
            codigo_fornecedor: document.getElementById('codigo_fornecedor').value.trim(),
            ncm: document.getElementById('ncm').value.trim(),
            descricao: document.getElementById('descricao').value.trim(),
            unidade: document.getElementById('unidade').value,
            valor_unitario: parseFloat(document.getElementById('valor_unitario').value)
        };
    } else {
        // MODO CRIAÇÃO: todos os campos
        formData = {
            codigo_fornecedor: document.getElementById('codigo_fornecedor').value.trim(),
            ncm: document.getElementById('ncm').value.trim(),
            marca: document.getElementById('marca').value.trim(),
            descricao: document.getElementById('descricao').value.trim(),
            unidade: document.getElementById('unidade').value,
            quantidade: parseInt(document.getElementById('quantidade').value),
            valor_unitario: parseFloat(document.getElementById('valor_unitario').value),
            grupo_id: document.getElementById('grupo').value
        };

        if (!formData.grupo_id) {
            showMessage('Selecione um grupo', 'error');
            switchTab('produto');
            return;
        }
    }

    try {
        const url = editingProductId 
            ? `${API_URL}/estoque/${editingProductId}`
            : `${API_URL}/estoque`;
        
        const method = editingProductId ? 'PUT' : 'POST';

        const response = await fetch(url, {
            method,
            headers: {
                'Content-Type': 'application/json',
                'X-Session-Token': sessionToken
            },
            body: JSON.stringify(formData)
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Erro ao salvar');
        }

        const savedProduct = await response.json();
        
        await loadProducts();
        closeFormModal(false);
        
        if (editingProductId) {
            showMessage(`${savedProduct.codigo} atualizado`, 'success');
        } else {
            showMessage(`${savedProduct.codigo} registrado`, 'success');
            showMessage(`Entrada de ${formData.quantidade} para o item ${savedProduct.codigo}`, 'success');
        }
    } catch (error) {
        showMessage(error.message, 'error');
    }
};

// MODAL DE VISUALIZAÇÃO
window.editProduct = async function(id) {
    const produto = produtos.find(p => p.id === id);
    if (!produto) return;

    editingProductId = id;
    formCancelado = false;
    document.getElementById('formTitle').textContent = 'Editar Produto';
    
    // Campos editáveis
    document.getElementById('codigo_fornecedor').value = produto.codigo_fornecedor;
    document.getElementById('ncm').value = produto.ncm || '';
    document.getElementById('descricao').value = produto.descricao;
    document.getElementById('unidade').value = produto.unidade || 'UN';
    
    // Valor unitário EDITÁVEL
    document.getElementById('valor_unitario').value = parseFloat(produto.valor_unitario).toFixed(2);
    document.getElementById('valor_unitario').disabled = false;
    
    // Campos NÃO editáveis
    document.getElementById('marca').value = produto.marca;
    document.getElementById('marca').disabled = true;
    
    document.getElementById('quantidade').value = produto.quantidade;
    document.getElementById('quantidade').disabled = true;
    
    document.getElementById('grupo').value = produto.grupo_id || '';
    document.getElementById('grupo').disabled = true;
    
    // Ocultar botão de adicionar grupo
    const btnAddGrupo = document.getElementById('btnAddGrupo');
    if (btnAddGrupo) {
        btnAddGrupo.style.display = 'none';
    }
    
    switchTab('fornecedor');
    document.getElementById('formModal').classList.add('show');
};

// MODAL DE ENTRADA
let entradaProductId = null;

window.openEntradaModal = function(id) {
    const produto = produtos.find(p => p.id === id);
    if (!produto) return;

    entradaProductId = id;
    document.getElementById('entradaProduto').textContent = `${produto.codigo} - ${produto.codigo_fornecedor}`;
    document.getElementById('entradaQuantidadeAtual').textContent = produto.quantidade;
    document.getElementById('entradaQuantidade').value = '';
    document.getElementById('entradaModal').classList.add('show');
};

window.closeEntradaModal = function() {
    document.getElementById('entradaModal').classList.remove('show');
    entradaProductId = null;
};

window.processarEntrada = async function(event) {
    event.preventDefault();
    
    const quantidade = parseInt(document.getElementById('entradaQuantidade').value);
    
    if (quantidade <= 0) {
        showMessage('Quantidade inválida', 'error');
        return;
    }

    try {
        const response = await fetch(`${API_URL}/estoque/${entradaProductId}/movimentar`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Session-Token': sessionToken
            },
            body: JSON.stringify({
                tipo: 'entrada',
                quantidade: quantidade
            })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Erro ao processar entrada');
        }

        const produto = await response.json();
        
        await loadProducts();
        closeEntradaModal();
        showMessage(`Entrada de ${quantidade} para o item ${produto.codigo}`, 'success');
    } catch (error) {
        showMessage(error.message, 'error');
    }
};

// MODAL DE SAÍDA
let saidaProductId = null;

window.openSaidaModal = function(id) {
    const produto = produtos.find(p => p.id === id);
    if (!produto) return;

    saidaProductId = id;
    document.getElementById('saidaProduto').textContent = `${produto.codigo} - ${produto.codigo_fornecedor}`;
    document.getElementById('saidaQuantidadeAtual').textContent = produto.quantidade;
    document.getElementById('saidaQuantidade').value = '';
    document.getElementById('saidaModal').classList.add('show');
};

window.closeSaidaModal = function() {
    document.getElementById('saidaModal').classList.remove('show');
    saidaProductId = null;
};

window.processarSaida = async function(event) {
    event.preventDefault();
    
    const quantidade = parseInt(document.getElementById('saidaQuantidade').value);
    
    if (quantidade <= 0) {
        showMessage('Quantidade inválida', 'error');
        return;
    }

    try {
        const response = await fetch(`${API_URL}/estoque/${saidaProductId}/movimentar`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Session-Token': sessionToken
            },
            body: JSON.stringify({
                tipo: 'saida',
                quantidade: quantidade
            })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Erro ao processar saída');
        }

        const produto = await response.json();
        
        await loadProducts();
        closeSaidaModal();
        showMessage(`Saída de ${quantidade} para o item ${produto.codigo}`, 'error');
    } catch (error) {
        showMessage(error.message, 'error');
    }
};

// ===== HISTÓRICO DE MOVIMENTAÇÕES =====

window.openHistoryModal = async function() {
    currentHistoryType = 'entrada';
    currentHistoryPage = 1;
    document.getElementById('historyModal').classList.add('show');
    
    // Reset tab buttons
    document.querySelectorAll('#historyModal .tab-button').forEach(btn => {
        btn.classList.remove('active');
    });
    document.querySelector('#historyModal .tab-button:first-child').classList.add('active');
    
    await loadHistoryData();
};

window.closeHistoryModal = function() {
    document.getElementById('historyModal').classList.remove('show');
};

window.switchHistoryTab = async function(tipo) {
    currentHistoryType = tipo;
    currentHistoryPage = 1;
    
    // Update tab buttons
    document.querySelectorAll('#historyModal .tab-button').forEach(btn => {
        btn.classList.remove('active');
    });
    event.target.classList.add('active');
    
    await loadHistoryData();
};

window.previousHistoryPage = async function() {
    if (currentHistoryPage > 1) {
        currentHistoryPage--;
        await loadHistoryData();
    }
};

window.nextHistoryPage = async function() {
    if (currentHistoryPage < historyData.pagination.totalPages) {
        currentHistoryPage++;
        await loadHistoryData();
    }
};

async function loadHistoryData() {
    const tbody = document.getElementById('historyTableBody');
    tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 2rem;">Carregando...</td></tr>';
    
    try {
        const response = await fetch(`${API_URL}/movimentacoes?tipo=${currentHistoryType}&page=${currentHistoryPage}&limit=4`, {
            headers: {
                'X-Session-Token': sessionToken,
                'Accept': 'application/json'
            }
        });

        if (!response.ok) throw new Error('Erro ao carregar histórico');

        historyData = await response.json();
        renderHistoryTable();
        updatePagination();
    } catch (error) {
        console.error('Erro ao carregar histórico:', error);
        tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 2rem; color: var(--alert-color);">Erro ao carregar dados</td></tr>';
    }
}

function renderHistoryTable() {
    const tbody = document.getElementById('historyTableBody');
    
    if (!historyData.data || historyData.data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 2rem;">Nenhuma movimentação encontrada</td></tr>';
        return;
    }

    tbody.innerHTML = historyData.data.map(mov => {
        const data = new Date(mov.created_at);
        const dataFormatada = data.toLocaleDateString('pt-BR');
        const horaFormatada = data.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        
        return `
            <tr>
                <td><strong>${mov.codigo_produto}</strong></td>
                <td>${mov.marca}</td>
                <td>${mov.codigo_fornecedor}</td>
                <td><strong>${mov.quantidade}</strong></td>
                <td>${dataFormatada} às ${horaFormatada}</td>
            </tr>
        `;
    }).join('');
}

function updatePagination() {
    const prevBtn = document.getElementById('prevPageBtn');
    const nextBtn = document.getElementById('nextPageBtn');
    const pageInfo = document.getElementById('pageInfo');
    
    prevBtn.disabled = currentHistoryPage === 1;
    nextBtn.disabled = currentHistoryPage >= historyData.pagination.totalPages;
    pageInfo.textContent = `Página ${currentHistoryPage} de ${historyData.pagination.totalPages}`;
}

// ===== GERAR PDF ORGANIZADO POR GRUPO =====

window.generateInventoryPDF = function() {
    if (produtos.length === 0) {
        showMessage('Nenhum produto para gerar relatório', 'error');
        return;
    }

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF('landscape');

    // Título
    doc.setFontSize(18);
    doc.setFont(undefined, 'bold');
    doc.text('RELATÓRIO DE ESTOQUE', 148, 15, { align: 'center' });

    // Data e hora
    doc.setFontSize(10);
    doc.setFont(undefined, 'normal');
    const dataHora = new Date().toLocaleString('pt-BR');
    doc.text(`Gerado em: ${dataHora}`, 148, 22, { align: 'center' });

    // Organizar produtos por grupo
    const produtosPorGrupo = {};
    produtos.forEach(produto => {
        const grupoNome = produto.grupos ? produto.grupos.nome : 'SEM GRUPO';
        if (!produtosPorGrupo[grupoNome]) {
            produtosPorGrupo[grupoNome] = [];
        }
        produtosPorGrupo[grupoNome].push(produto);
    });

    // Ordenar grupos alfabeticamente
    const gruposOrdenados = Object.keys(produtosPorGrupo).sort();

    let startY = 30;
    const totaisPorGrupo = {};
    let valorTotalGeral = 0;
    let quantidadeTotalGeral = 0;

    gruposOrdenados.forEach((grupoNome) => {
        // Verificar se precisa adicionar nova página
        if (startY > 170) {
            doc.addPage();
            startY = 15;
        }

        // Nome do grupo
        doc.setFontSize(14);
        doc.setFont(undefined, 'bold');
        doc.setTextColor(204, 112, 0);
        doc.text(grupoNome, 14, startY);
        startY += 8;

        // Ordenar produtos por código (crescente)
        const produtosOrdenados = produtosPorGrupo[grupoNome].sort((a, b) => {
            return parseInt(a.codigo) - parseInt(b.codigo);
        });

        // Preparar dados da tabela
        const tableData = produtosOrdenados.map(p => [
            p.codigo.toString(),
            p.marca,
            p.codigo_fornecedor,
            p.ncm || '-',
            p.descricao,
            p.unidade || 'UN',
            p.quantidade.toString(),
formatarMoeda(parseFloat(p.valor_unitario)),
formatarMoeda(p.quantidade * parseFloat(p.valor_unitario))
        ]);

        // Adicionar tabela
        doc.autoTable({
            startY: startY,
            head: [['Código', 'Marca', 'Modelo', 'NCM', 'Descrição', 'Un.', 'Qtd', 'Valor Un.', 'Valor Total']],
            body: tableData,
            theme: 'grid',
            headStyles: {
                fillColor: [107, 114, 128],
                textColor: [255, 255, 255],
                fontSize: 8,
                fontStyle: 'bold'
            },
            bodyStyles: {
                fontSize: 7,
                textColor: [26, 26, 26]
            },
            alternateRowStyles: {
                fillColor: [250, 250, 250]
            },
            columnStyles: {
                0: { cellWidth: 18 },
                1: { cellWidth: 22 },
                2: { cellWidth: 22 },
                3: { cellWidth: 18 },
                4: { cellWidth: 80 },
                5: { cellWidth: 12, halign: 'center' },
                6: { cellWidth: 15, halign: 'center' },
                7: { cellWidth: 25, halign: 'right' },
                8: { cellWidth: 28, halign: 'right' }
            },
            margin: { left: 14, right: 14 }
        });

        startY = doc.lastAutoTable.finalY + 8;

        // Calcular totais do grupo
        const quantidadeGrupo = produtosOrdenados.reduce((acc, p) => acc + p.quantidade, 0);
        const valorGrupo = produtosOrdenados.reduce((acc, p) => {
            return acc + (p.quantidade * parseFloat(p.valor_unitario));
        }, 0);

        totaisPorGrupo[grupoNome] = {
            quantidade: quantidadeGrupo,
            valor: valorGrupo,
            itens: produtosOrdenados.length
        };

        valorTotalGeral += valorGrupo;
        quantidadeTotalGeral += quantidadeGrupo;

        // Exibir totais do grupo
        doc.setFontSize(10);
        doc.setFont(undefined, 'bold');
        doc.setTextColor(0, 0, 0);
        doc.text(`Total de Itens: ${produtosOrdenados.length}`, 14, startY);
        startY += 6;
        doc.text(`Quantidade Total: ${quantidadeGrupo}`, 14, startY);
        startY += 6;
        doc.text(`Valor Total: ${formatarMoeda(valorGrupo)}`, 14, startY);
        startY += 12;
    });

// Totais gerais na última página
if (startY > 160) {
    doc.addPage();
    startY = 15;
} else {
    startY += 30; // 🎯 ADICIONAR ESPAÇAMENTO EXTRA (ajuste o valor conforme necessário)
}

    doc.setFontSize(14);
    doc.setFont(undefined, 'bold');
    doc.setTextColor(0, 0, 0);
    doc.text('TOTAIS GERAIS:', 14, startY);
    startY += 10;

doc.setFontSize(11);
doc.setFont(undefined, 'normal');
doc.text(`Total de Produtos: ${produtos.length}`, 14, startY);
startY += 7;
doc.text(`Valor Total em Estoque: ${formatarMoeda(valorTotalGeral)}`, 14, startY); // ✅ ÚNICO

    // Salvar PDF
    doc.save(`Relatorio_Estoque_${new Date().toISOString().split('T')[0]}.pdf`);
    showMessage('Relatório PDF gerado com sucesso!', 'success');
};

function showMessage(message, type = 'success') {
    const div = document.createElement('div');
    div.className = `floating-message ${type}`;
    div.textContent = message;
    document.body.appendChild(div);
    setTimeout(() => {
        div.style.animation = 'slideOut 0.3s ease forwards';
        setTimeout(() => div.remove(), 300);
    }, 2000);
}
