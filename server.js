require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3002;

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('❌ ERRO: Variáveis de ambiente do Supabase não configuradas');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// ─── MIDDLEWARES ──────────────────────────────────────────────────────────────

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Session-Token', 'Accept'],
    credentials: true
}));

app.options('*', cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── LOG DE ACESSOS ───────────────────────────────────────────────────────────

const logFilePath = path.join(__dirname, 'acessos.log');
let accessCount = 0;
let uniqueIPs = new Set();

app.use((req, res, next) => {
    const xForwardedFor = req.headers['x-forwarded-for'];
    const clientIP = (xForwardedFor ? xForwardedFor.split(',')[0].trim() : req.socket.remoteAddress).replace('::ffff:', '');
    fs.appendFile(logFilePath, `[${new Date().toISOString()}] ${clientIP} - ${req.method} ${req.path}\n`, () => {});
    accessCount++;
    uniqueIPs.add(clientIP);
    next();
});

setInterval(() => {
    if (accessCount > 0) {
        console.log(`📊 Última hora: ${accessCount} requisições de ${uniqueIPs.size} IPs únicos`);
        accessCount = 0;
        uniqueIPs.clear();
    }
}, 3600000);

// ─── AUTENTICAÇÃO ─────────────────────────────────────────────────────────────

const PORTAL_URL = process.env.PORTAL_URL || 'https://ir-comercio-portal-zcan.onrender.com';

async function verificarAutenticacao(req, res, next) {
    if (req.method === 'HEAD') return next();

    const publicPaths = ['/', '/health', '/app'];
    if (publicPaths.includes(req.path)) return next();

    const sessionToken = req.headers['x-session-token'] || req.query.sessionToken;

    if (!sessionToken) {
        return res.status(401).json({ error: 'Não autenticado', redirectToLogin: true });
    }

    try {
        const verifyResponse = await fetch(`${PORTAL_URL}/api/verify-session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionToken }),
            signal: AbortSignal.timeout(5000)
        });

        if (!verifyResponse.ok) {
            return res.status(401).json({ error: 'Sessão inválida', redirectToLogin: true });
        }

        const sessionData = await verifyResponse.json();
        if (!sessionData.valid) {
            return res.status(401).json({ error: 'Sessão inválida', redirectToLogin: true });
        }

        req.user = sessionData.session;
        next();
    } catch (error) {
        if (error.name === 'AbortError' || error.code === 'ECONNREFUSED') {
            req.user = { offline: true };
            return next();
        }
        return res.status(500).json({ error: 'Erro ao verificar autenticação' });
    }
}

// ─── ARQUIVOS ESTÁTICOS ───────────────────────────────────────────────────────

const publicPath = path.join(__dirname, 'public');
if (!fs.existsSync(publicPath)) fs.mkdirSync(publicPath, { recursive: true });

app.use(express.static(publicPath, {
    index: 'index.html',
    dotfiles: 'deny',
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) res.setHeader('Content-Type', 'text/html; charset=utf-8');
        else if (filePath.endsWith('.css'))  res.setHeader('Content-Type', 'text/css; charset=utf-8');
        else if (filePath.endsWith('.js'))   res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    }
}));

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────

app.get('/health', async (req, res) => {
    try {
        const { count, error } = await supabase
            .from('estoque')
            .select('*', { count: 'exact', head: true });
        res.json({
            status: error ? 'unhealthy' : 'healthy',
            database: error ? 'disconnected' : 'connected',
            timestamp: new Date().toISOString(),
            produtos: count || 0
        });
    } catch (e) {
        res.status(500).json({ status: 'unhealthy', timestamp: new Date().toISOString() });
    }
});

app.head('/api/estoque', (req, res) => res.status(200).end());

app.use('/api', verificarAutenticacao);

// ============================================================
// TABELA ÚNICA: estoque
// ─────────────────────
// id                UUID PRIMARY KEY DEFAULT gen_random_uuid()
// codigo            INTEGER UNIQUE NOT NULL
// codigo_fornecedor TEXT NOT NULL
// ncm               TEXT
// marca             TEXT NOT NULL
// descricao         TEXT NOT NULL
// unidade           TEXT NOT NULL DEFAULT 'UN'
// quantidade        INTEGER NOT NULL DEFAULT 0
// valor_unitario    NUMERIC(12,2) NOT NULL
// grupo_codigo      INTEGER NOT NULL
// grupo_nome        TEXT NOT NULL
// timestamp         TIMESTAMPTZ DEFAULT now()
// ============================================================

// ─── GRUPOS (derivados da tabela estoque) ────────────────────────────────────

// Listar grupos únicos
app.get('/api/grupos', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('estoque')
            .select('grupo_codigo, grupo_nome')
            .order('grupo_codigo', { ascending: true });

        if (error) throw error;

        const seen = new Set();
        const grupos = (data || []).filter(row => {
            if (seen.has(row.grupo_codigo)) return false;
            seen.add(row.grupo_codigo);
            return true;
        }).map(row => ({ codigo: row.grupo_codigo, nome: row.grupo_nome }));

        res.json(grupos);
    } catch (error) {
        console.error('❌ GET /grupos:', error);
        res.status(500).json({ error: 'Erro ao buscar grupos' });
    }
});

// Calcular próximo código de grupo (sem criar registro)
app.post('/api/grupos', async (req, res) => {
    try {
        const { nome } = req.body;
        if (!nome) return res.status(400).json({ error: 'Nome do grupo é obrigatório' });

        const nomeLimpo = nome.trim().toUpperCase();

        // Verificar duplicidade
        const { data: existing } = await supabase
            .from('estoque')
            .select('grupo_nome')
            .ilike('grupo_nome', nomeLimpo)
            .limit(1);

        if (existing && existing.length > 0) {
            return res.status(400).json({ error: 'Grupo já existe' });
        }

        // Calcular próximo código (múltiplos de 10000)
        const { data: maxData } = await supabase
            .from('estoque')
            .select('grupo_codigo')
            .order('grupo_codigo', { ascending: false })
            .limit(1);

        const ultimoCodigo = maxData && maxData.length > 0 ? maxData[0].grupo_codigo : 0;
        const proximoCodigo = Math.ceil(ultimoCodigo / 10000) * 10000 + 10000;

        res.status(201).json({ codigo: proximoCodigo, nome: nomeLimpo });
    } catch (error) {
        console.error('❌ POST /grupos:', error);
        res.status(500).json({ error: 'Erro ao criar grupo' });
    }
});

// Excluir grupo — remove TODOS os produtos do grupo
app.delete('/api/grupos/:grupo_codigo', async (req, res) => {
    try {
        const grupo_codigo = parseInt(req.params.grupo_codigo);
        if (isNaN(grupo_codigo)) return res.status(400).json({ error: 'Código inválido' });

        const { count } = await supabase
            .from('estoque')
            .select('*', { count: 'exact', head: true })
            .eq('grupo_codigo', grupo_codigo);

        const { error } = await supabase
            .from('estoque')
            .delete()
            .eq('grupo_codigo', grupo_codigo);

        if (error) throw error;

        res.json({ message: `Grupo e ${count || 0} produto(s) excluídos` });
    } catch (error) {
        console.error('❌ DELETE /grupos/:codigo:', error);
        res.status(500).json({ error: 'Erro ao excluir grupo' });
    }
});

// ─── ESTOQUE ──────────────────────────────────────────────────────────────────

// Listar produtos (paginado)
app.get('/api/estoque', async (req, res) => {
    try {
        const page         = parseInt(req.query.page)  || 1;
        const limit        = Math.min(parseInt(req.query.limit) || 50, 50);
        const grupo_codigo = req.query.grupo_codigo ? parseInt(req.query.grupo_codigo) : null;
        const search       = req.query.search || null;
        const from         = (page - 1) * limit;
        const to           = from + limit - 1;

        let query = supabase
            .from('estoque')
            .select('*', { count: 'exact' })
            .order('grupo_codigo', { ascending: true })
            .order('codigo',       { ascending: true });

        if (grupo_codigo) query = query.eq('grupo_codigo', grupo_codigo);

        if (search) {
            query = query.or(
                `codigo_fornecedor.ilike.%${search}%,` +
                `marca.ilike.%${search}%,` +
                `descricao.ilike.%${search}%`
            );
        }

        query = query.range(from, to);

        const { data, error, count } = await query;
        if (error) throw error;

        res.json({
            data: data || [],
            total: count || 0,
            page,
            limit,
            totalPages: Math.ceil((count || 0) / limit)
        });
    } catch (error) {
        console.error('❌ GET /estoque:', error);
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

        if (error) return res.status(404).json({ error: 'Produto não encontrado' });
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao buscar produto' });
    }
});

// Criar produto
app.post('/api/estoque', async (req, res) => {
    try {
        const {
            codigo_fornecedor, ncm, marca, descricao,
            unidade, quantidade, valor_unitario,
            grupo_codigo, grupo_nome
        } = req.body;

        if (!codigo_fornecedor || !marca || !descricao ||
            quantidade === undefined || valor_unitario === undefined ||
            !grupo_codigo || !grupo_nome) {
            return res.status(400).json({ error: 'Todos os campos obrigatórios devem ser preenchidos' });
        }

        // Verificar duplicidade de código_fornecedor
        const { data: existing } = await supabase
            .from('estoque')
            .select('id')
            .eq('codigo_fornecedor', codigo_fornecedor.trim())
            .maybeSingle();

        if (existing) {
            return res.status(400).json({ error: 'Código do fornecedor já cadastrado' });
        }

        // Próximo código sequencial dentro do grupo
        const { data: ultimoDoGrupo } = await supabase
            .from('estoque')
            .select('codigo')
            .eq('grupo_codigo', parseInt(grupo_codigo))
            .order('codigo', { ascending: false })
            .limit(1);

        const proximoCodigo = ultimoDoGrupo && ultimoDoGrupo.length > 0
            ? ultimoDoGrupo[0].codigo + 1
            : parseInt(grupo_codigo) + 1;

        const { data, error } = await supabase
            .from('estoque')
            .insert([{
                codigo:            proximoCodigo,
                codigo_fornecedor: codigo_fornecedor.trim(),
                ncm:               ncm ? ncm.trim() : null,
                marca:             marca.trim().toUpperCase(),
                descricao:         descricao.trim().toUpperCase(),
                unidade:           unidade || 'UN',
                quantidade:        parseInt(quantidade),
                valor_unitario:    parseFloat(valor_unitario),
                grupo_codigo:      parseInt(grupo_codigo),
                grupo_nome:        grupo_nome.trim().toUpperCase(),
                timestamp:         new Date().toISOString()
            }])
            .select()
            .single();

        if (error) throw error;
        res.status(201).json(data);
    } catch (error) {
        console.error('❌ POST /estoque:', error);
        res.status(500).json({ error: 'Erro ao criar produto' });
    }
});

// Atualizar produto
app.put('/api/estoque/:id', async (req, res) => {
    try {
        const { codigo_fornecedor, ncm, marca, descricao, unidade, valor_unitario } = req.body;

        if (!codigo_fornecedor || !marca || !descricao || valor_unitario === undefined) {
            return res.status(400).json({ error: 'Todos os campos obrigatórios devem ser preenchidos' });
        }

        const { data, error } = await supabase
            .from('estoque')
            .update({
                codigo_fornecedor: codigo_fornecedor.trim(),
                ncm:               ncm ? ncm.trim() : null,
                marca:             marca.trim().toUpperCase(),
                descricao:         descricao.trim().toUpperCase(),
                unidade:           unidade || 'UN',
                valor_unitario:    parseFloat(valor_unitario),
                timestamp:         new Date().toISOString()
            })
            .eq('id', req.params.id)
            .select()
            .single();

        if (error) return res.status(404).json({ error: 'Produto não encontrado' });
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao atualizar produto' });
    }
});

// Entrada de estoque
app.post('/api/estoque/:id/entrada', async (req, res) => {
    try {
        const { quantidade } = req.body;
        if (!quantidade || parseInt(quantidade) <= 0) {
            return res.status(400).json({ error: 'Quantidade inválida' });
        }

        const { data: produto, error: fetchError } = await supabase
            .from('estoque').select('quantidade').eq('id', req.params.id).single();

        if (fetchError || !produto) return res.status(404).json({ error: 'Produto não encontrado' });

        const { data, error } = await supabase
            .from('estoque')
            .update({
                quantidade: produto.quantidade + parseInt(quantidade),
                timestamp:  new Date().toISOString()
            })
            .eq('id', req.params.id)
            .select()
            .single();

        if (error) throw error;
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao registrar entrada' });
    }
});

// Saída de estoque
app.post('/api/estoque/:id/saida', async (req, res) => {
    try {
        const { quantidade } = req.body;
        if (!quantidade || parseInt(quantidade) <= 0) {
            return res.status(400).json({ error: 'Quantidade inválida' });
        }

        const { data: produto, error: fetchError } = await supabase
            .from('estoque').select('quantidade').eq('id', req.params.id).single();

        if (fetchError || !produto) return res.status(404).json({ error: 'Produto não encontrado' });

        if (produto.quantidade < parseInt(quantidade)) {
            return res.status(400).json({ error: 'Quantidade insuficiente em estoque' });
        }

        const { data, error } = await supabase
            .from('estoque')
            .update({
                quantidade: produto.quantidade - parseInt(quantidade),
                timestamp:  new Date().toISOString()
            })
            .eq('id', req.params.id)
            .select()
            .single();

        if (error) throw error;
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao registrar saída' });
    }
});

// Deletar produto
app.delete('/api/estoque/:id', async (req, res) => {
    try {
        const { error } = await supabase.from('estoque').delete().eq('id', req.params.id);
        if (error) throw error;
        res.status(204).end();
    } catch (error) {
        res.status(500).json({ error: 'Erro ao excluir produto' });
    }
});

// ─── ROTAS PRINCIPAIS ─────────────────────────────────────────────────────────

app.get('/',    (req, res) => res.sendFile(path.join(publicPath, 'index.html')));
app.get('/app', (req, res) => res.sendFile(path.join(publicPath, 'index.html')));

app.use((req, res) => res.status(404).json({ error: '404 - Rota não encontrada' }));
app.use((err, req, res, next) => res.status(500).json({ error: 'Erro interno do servidor' }));

// ─── INICIAR ──────────────────────────────────────────────────────────────────

const server = app.listen(PORT, '0.0.0.0', () => {
    console.log('\n🚀 ========================================');
    console.log('✅ Servidor Estoque ONLINE');
    console.log(`✅ Porta: ${PORT}`);
    console.log('✅ Tabela única: estoque');
    console.log('🚀 ========================================\n');
});

process.on('SIGTERM', () => {
    server.close(() => { console.log('✅ Servidor encerrado'); process.exit(0); });
});

(async () => {
    try {
        const { count, error } = await supabase
            .from('estoque')
            .select('*', { count: 'exact', head: true });
        if (error) console.error('❌ Erro Supabase:', error.message);
        else console.log(`✅ Supabase conectado (${count || 0} produtos)`);
    } catch (e) {
        console.error('❌ Erro ao testar conexão:', e.message);
    }
})();
