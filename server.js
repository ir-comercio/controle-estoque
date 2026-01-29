require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3002;

// CONFIGURAÇÃO DO SUPABASE
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('❌ ERRO: Variáveis de ambiente do Supabase não configuradas');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// MIDDLEWARES
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Session-Token']
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// REGISTRO DE ACESSOS SILENCIOSO
const logFilePath = path.join(__dirname, 'acessos.log');
let accessCount = 0;
let uniqueIPs = new Set();

function registrarAcesso(req, res, next) {
    const xForwardedFor = req.headers['x-forwarded-for'];
    const clientIP = xForwardedFor
        ? xForwardedFor.split(',')[0].trim()
        : req.socket.remoteAddress;

    const cleanIP = clientIP.replace('::ffff:', '');
    const logEntry = `[${new Date().toISOString()}] ${cleanIP} - ${req.method} ${req.path}\n`;

    fs.appendFile(logFilePath, logEntry, () => {});
    accessCount++;
    uniqueIPs.add(cleanIP);
    next();
}

app.use(registrarAcesso);

setInterval(() => {
    if (accessCount > 0) {
        console.log(`📊 Última hora: ${accessCount} requisições de ${uniqueIPs.size} IPs únicos`);
        accessCount = 0;
        uniqueIPs.clear();
    }
}, 3600000);

// AUTENTICAÇÃO
const PORTAL_URL = process.env.PORTAL_URL || 'https://ir-comercio-portal-zcan.onrender.com';

async function verificarAutenticacao(req, res, next) {
    const publicPaths = ['/', '/health', '/app'];
    if (publicPaths.includes(req.path)) {
        return next();
    }

    const sessionToken = req.headers['x-session-token'] || req.query.sessionToken;

    if (!sessionToken) {
        return res.status(401).json({
            error: 'Não autenticado',
            redirectToLogin: true
        });
    }

    try {
        const verifyResponse = await fetch(`${PORTAL_URL}/api/verify-session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionToken })
        });

        if (!verifyResponse.ok) {
            return res.status(401).json({
                error: 'Sessão inválida',
                redirectToLogin: true
            });
        }

        const sessionData = await verifyResponse.json();

        if (!sessionData.valid) {
            return res.status(401).json({
                error: 'Sessão inválida',
                redirectToLogin: true
            });
        }

        req.user = sessionData.session;
        req.sessionToken = sessionToken;
        next();
    } catch (error) {
        return res.status(500).json({
            error: 'Erro ao verificar autenticação'
        });
    }
}

// ARQUIVOS ESTÁTICOS
const publicPath = path.join(__dirname, 'public');

app.use(express.static(publicPath, {
    index: 'index.html',
    dotfiles: 'deny',
    setHeaders: (res, path) => {
        if (path.endsWith('.html')) {
            res.setHeader('Content-Type', 'text/html');
        } else if (path.endsWith('.css')) {
            res.setHeader('Content-Type', 'text/css');
        } else if (path.endsWith('.js')) {
            res.setHeader('Content-Type', 'application/javascript');
        }
    }
}));

// HEALTH CHECK
app.get('/health', async (req, res) => {
    try {
        const { error } = await supabase
            .from('estoque')
            .select('count', { count: 'exact', head: true });
        
        res.json({
            status: error ? 'unhealthy' : 'healthy',
            database: error ? 'disconnected' : 'connected',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.json({
            status: 'unhealthy',
            timestamp: new Date().toISOString()
        });
    }
});

// ROTAS DA API
app.use('/api', verificarAutenticacao);

app.head('/api/estoque', (req, res) => {
    res.status(200).end();
});

// ===== ROTAS DE GRUPOS =====

// Listar todos os grupos (extrair grupos únicos da tabela estoque)
app.get('/api/grupos', async (req, res) => {
    try {
        // Buscar grupos únicos da tabela estoque
        const { data, error } = await supabase
            .from('estoque')
            .select('grupo_codigo, grupo_nome')
            .order('grupo_codigo', { ascending: true });

        if (error) throw error;

        // Extrair grupos únicos
        const gruposUnicos = [];
        const gruposSet = new Set();

        data.forEach(item => {
            const key = `${item.grupo_codigo}-${item.grupo_nome}`;
            if (!gruposSet.has(key)) {
                gruposSet.add(key);
                gruposUnicos.push({
                    codigo: item.grupo_codigo,
                    nome: item.grupo_nome
                });
            }
        });

        res.json(gruposUnicos);
    } catch (error) {
        console.error('Erro ao buscar grupos:', error);
        res.status(500).json({ error: 'Erro ao buscar grupos' });
    }
});

// Criar novo grupo (criar produto inicial para o grupo)
app.post('/api/grupos', async (req, res) => {
    try {
        const { nome } = req.body;

        if (!nome) {
            return res.status(400).json({ error: 'Nome do grupo é obrigatório' });
        }

        // Obter próximo código de grupo (múltiplo de 10000)
        const { data: maxData } = await supabase
            .from('estoque')
            .select('grupo_codigo')
            .order('grupo_codigo', { ascending: false })
            .limit(1)
            .single();

        const proximoCodigo = maxData ? maxData.grupo_codigo + 10000 : 10000;

        // Criar produto inicial para o grupo
        const { data, error } = await supabase
            .from('estoque')
            .insert([{
                codigo: proximoCodigo + 1,
                codigo_fornecedor: `GRUPO-${proximoCodigo}`,
                marca: 'SISTEMA',
                descricao: `GRUPO ${nome.trim().toUpperCase()}`,
                grupo_codigo: proximoCodigo,
                grupo_nome: nome.trim().toUpperCase(),
                quantidade: 0,
                valor_unitario: 0.01,
                unidade: 'UN'
            }])
            .select()
            .single();

        if (error) throw error;

        res.status(201).json({
            codigo: data.grupo_codigo,
            nome: data.grupo_nome,
            created_at: data.created_at
        });
    } catch (error) {
        console.error('Erro ao criar grupo:', error);
        if (error.code === '23505') {
            res.status(400).json({ error: 'Grupo já existe' });
        } else {
            res.status(500).json({ error: 'Erro ao criar grupo' });
        }
    }
});

// ===== ROTAS DE ESTOQUE =====

// Listar produtos
app.get('/api/estoque', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('estoque')
            .select('*')
            .order('codigo', { ascending: true });

        if (error) throw error;

        // Transformar para manter compatibilidade com frontend
        const transformed = data.map(item => ({
            ...item,
            grupos: {
                id: null,
                codigo: item.grupo_codigo,
                nome: item.grupo_nome
            }
        }));

        res.json(transformed);
    } catch (error) {
        console.error('Erro ao buscar produtos:', error);
        res.status(500).json({ error: 'Erro ao buscar produtos' });
    }
});

// Buscar produto específico
app.get('/api/estoque/:id', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('estoque')
            .select('*')
            .eq('id', req.params.id)
            .single();

        if (error) {
            return res.status(404).json({ error: 'Produto não encontrado' });
        }

        // Transformar para compatibilidade
        const transformed = {
            ...data,
            grupos: {
                id: null,
                codigo: data.grupo_codigo,
                nome: data.grupo_nome
            }
        };
        
        res.json(transformed);
    } catch (error) {
        console.error('Erro ao buscar produto:', error);
        res.status(500).json({ error: 'Erro ao buscar produto' });
    }
});

// Criar produto
app.post('/api/estoque', async (req, res) => {
    try {
        const { codigo_fornecedor, ncm, marca, descricao, unidade, quantidade, valor_unitario, grupo_id } = req.body;

        if (!codigo_fornecedor || !marca || !descricao || quantidade === undefined || valor_unitario === undefined || !grupo_id) {
            return res.status(400).json({ error: 'Todos os campos obrigatórios devem ser preenchidos' });
        }

        // Verificar se código do fornecedor já existe
        const { data: existing } = await supabase
            .from('estoque')
            .select('id')
            .eq('codigo_fornecedor', codigo_fornecedor)
            .single();

        if (existing) {
            return res.status(400).json({ error: 'Código do fornecedor já cadastrado' });
        }

        // Buscar informações do grupo (grupo_id é o código do grupo)
        const { data: grupoData } = await supabase
            .from('estoque')
            .select('grupo_codigo, grupo_nome')
            .eq('grupo_codigo', grupo_id)
            .limit(1)
            .single();

        if (!grupoData) {
            return res.status(400).json({ error: 'Grupo inválido' });
        }

        // Obter último código do grupo
        const { data: ultimoProdutoGrupo } = await supabase
            .from('estoque')
            .select('codigo')
            .eq('grupo_codigo', grupoData.grupo_codigo)
            .order('codigo', { ascending: false })
            .limit(1)
            .single();

        const proximoCodigo = ultimoProdutoGrupo 
            ? ultimoProdutoGrupo.codigo + 1
            : grupoData.grupo_codigo + 1;

        // Criar movimentação de entrada
        const movimentacaoInicial = [{
            id: crypto.randomUUID(),
            tipo: 'entrada',
            quantidade: parseInt(quantidade),
            codigo_produto: proximoCodigo,
            marca: marca.trim().toUpperCase(),
            codigo_fornecedor: codigo_fornecedor.trim(),
            created_at: new Date().toISOString()
        }];

        const { data, error } = await supabase
            .from('estoque')
            .insert([{
                codigo: proximoCodigo,
                codigo_fornecedor: codigo_fornecedor.trim(),
                ncm: ncm ? ncm.trim() : null,
                marca: marca.trim().toUpperCase(),
                descricao: descricao.trim().toUpperCase(),
                unidade: unidade || 'UN',
                quantidade: parseInt(quantidade),
                valor_unitario: parseFloat(valor_unitario),
                grupo_codigo: grupoData.grupo_codigo,
                grupo_nome: grupoData.grupo_nome,
                movimentacoes: movimentacaoInicial,
                timestamp: new Date().toISOString()
            }])
            .select()
            .single();

        if (error) throw error;

        res.status(201).json(data);
    } catch (error) {
        console.error('Erro ao criar produto:', error);
        res.status(500).json({ error: 'Erro ao criar produto' });
    }
});

// Atualizar produto
app.put('/api/estoque/:id', async (req, res) => {
    try {
        const { codigo_fornecedor, ncm, marca, descricao, unidade, valor_unitario, grupo_id } = req.body;

        if (!codigo_fornecedor || !marca || !descricao || valor_unitario === undefined) {
            return res.status(400).json({ error: 'Todos os campos obrigatórios devem ser preenchidos' });
        }

        const updateData = {
            codigo_fornecedor: codigo_fornecedor.trim(),
            ncm: ncm ? ncm.trim() : null,
            marca: marca.trim().toUpperCase(),
            descricao: descricao.trim().toUpperCase(),
            unidade: unidade || 'UN',
            valor_unitario: parseFloat(valor_unitario),
            timestamp: new Date().toISOString()
        };

        // Se mudou o grupo, atualizar também
        if (grupo_id) {
            const { data: grupoData } = await supabase
                .from('estoque')
                .select('grupo_codigo, grupo_nome')
                .eq('grupo_codigo', grupo_id)
                .limit(1)
                .single();

            if (grupoData) {
                updateData.grupo_codigo = grupoData.grupo_codigo;
                updateData.grupo_nome = grupoData.grupo_nome;
            }
        }

        const { data, error } = await supabase
            .from('estoque')
            .update(updateData)
            .eq('id', req.params.id)
            .select()
            .single();

        if (error) {
            return res.status(404).json({ error: 'Produto não encontrado' });
        }
        
        res.json(data);
    } catch (error) {
        console.error('Erro ao atualizar produto:', error);
        res.status(500).json({ error: 'Erro ao atualizar produto' });
    }
});

// Movimentação de estoque (entrada/saída)
app.post('/api/estoque/:id/movimentar', async (req, res) => {
    try {
        const { tipo, quantidade } = req.body;

        if (!['entrada', 'saida'].includes(tipo) || !quantidade || quantidade <= 0) {
            return res.status(400).json({ error: 'Dados inválidos' });
        }

        // Buscar produto atual
        const { data: produto, error: fetchError } = await supabase
            .from('estoque')
            .select('*')
            .eq('id', req.params.id)
            .single();

        if (fetchError || !produto) {
            return res.status(404).json({ error: 'Produto não encontrado' });
        }

        // Calcular nova quantidade
        let novaQuantidade = produto.quantidade;
        if (tipo === 'entrada') {
            novaQuantidade += parseInt(quantidade);
        } else {
            if (produto.quantidade < parseInt(quantidade)) {
                return res.status(400).json({ error: 'Quantidade insuficiente em estoque' });
            }
            novaQuantidade -= parseInt(quantidade);
        }

        // Criar nova movimentação
        const novaMovimentacao = {
            id: crypto.randomUUID(),
            tipo: tipo,
            quantidade: parseInt(quantidade),
            codigo_produto: produto.codigo,
            marca: produto.marca,
            codigo_fornecedor: produto.codigo_fornecedor,
            created_at: new Date().toISOString()
        };

        // Adicionar movimentação ao array
        const movimentacoesAtualizadas = [
            ...(produto.movimentacoes || []),
            novaMovimentacao
        ];

        // Atualizar produto
        const { data, error } = await supabase
            .from('estoque')
            .update({
                quantidade: novaQuantidade,
                movimentacoes: movimentacoesAtualizadas,
                timestamp: new Date().toISOString()
            })
            .eq('id', req.params.id)
            .select()
            .single();

        if (error) throw error;

        res.json(data);
    } catch (error) {
        console.error('Erro ao movimentar estoque:', error);
        res.status(500).json({ error: 'Erro ao movimentar estoque' });
    }
});

// Deletar produto
app.delete('/api/estoque/:id', async (req, res) => {
    try {
        const { error } = await supabase
            .from('estoque')
            .delete()
            .eq('id', req.params.id);

        if (error) throw error;
        res.status(204).end();
    } catch (error) {
        console.error('Erro ao excluir produto:', error);
        res.status(500).json({ error: 'Erro ao excluir produto' });
    }
});

// ===== ROTAS DE MOVIMENTAÇÕES =====

// Listar movimentações (extrair do JSON de todos os produtos)
app.get('/api/movimentacoes', async (req, res) => {
    try {
        const { tipo, page = 1, limit = 4 } = req.query;

        // Buscar todos os produtos com movimentações
        const { data: produtos, error } = await supabase
            .from('estoque')
            .select('id, movimentacoes')
            .not('movimentacoes', 'is', null);

        if (error) throw error;

        // Extrair e consolidar todas as movimentações
        let todasMovimentacoes = [];
        produtos.forEach(produto => {
            if (produto.movimentacoes && Array.isArray(produto.movimentacoes)) {
                produto.movimentacoes.forEach(mov => {
                    todasMovimentacoes.push({
                        ...mov,
                        estoque_id: produto.id
                    });
                });
            }
        });

        // Filtrar por tipo se especificado
        if (tipo && ['entrada', 'saida'].includes(tipo)) {
            todasMovimentacoes = todasMovimentacoes.filter(m => m.tipo === tipo);
        }

        // Ordenar por data (mais recente primeiro)
        todasMovimentacoes.sort((a, b) => 
            new Date(b.created_at) - new Date(a.created_at)
        );

        // Paginar
        const total = todasMovimentacoes.length;
        const offset = (page - 1) * limit;
        const paginadas = todasMovimentacoes.slice(offset, offset + parseInt(limit));

        res.json({
            data: paginadas,
            pagination: {
                total: total,
                page: parseInt(page),
                limit: parseInt(limit),
                totalPages: Math.ceil(total / parseInt(limit))
            }
        });
    } catch (error) {
        console.error('Erro ao buscar movimentações:', error);
        res.status(500).json({ error: 'Erro ao buscar movimentações' });
    }
});

// ROTA PRINCIPAL
app.get('/', (req, res) => {
    res.sendFile(path.join(publicPath, 'index.html'));
});

app.get('/app', (req, res) => {
    res.sendFile(path.join(publicPath, 'index.html'));
});

// 404
app.use((req, res) => {
    res.status(404).json({
        error: '404 - Rota não encontrada'
    });
});

// TRATAMENTO DE ERROS
app.use((error, req, res, next) => {
    console.error('Erro interno:', error);
    res.status(500).json({
        error: 'Erro interno do servidor'
    });
});

// INICIAR SERVIDOR
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Servidor rodando na porta ${PORT}`);
    console.log(`✅ Database: Conectado`);
    console.log(`✅ Autenticação: Ativa`);
    console.log(`✅ Modo: Tabela Única (sem views/funções)`);
    console.log(`📝 Logs salvos em: acessos.log\n`);
});

// Verificar pasta public
if (!fs.existsSync(publicPath)) {
    console.error('⚠️  Pasta public/ não encontrada!');
}
