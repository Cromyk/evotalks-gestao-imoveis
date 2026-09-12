/* Gerenciamento de Imóveis — camada comum às três telas.
   Roda dentro do contêiner da extensão: origem opaca, sem cookie, sem JWT.
   Tudo que fala com o EvoTalks passa por window.omni. */
(function (global) {
  'use strict';

  var GI = {};
  var ctx = null;

  /* ---------------------------------------------------------------- contexto */

  GI.ctx = function () { return ctx; };
  GI.cfg = function (chave, padrao) {
    var v = ctx && ctx.config ? ctx.config[chave] : undefined;
    return (v === undefined || v === null || v === '') ? padrao : v;
  };
  GI.usuario = function () {
    return (ctx && ctx.user) ? (ctx.user.name || ctx.user.id) : 'desconhecido';
  };

  GI.pronto = function (fn) {
    function aplicarTema(c) {
      var tokens = (c && c.theme && c.theme.tokens) || {};
      for (var k in tokens) {
        if (Object.prototype.hasOwnProperty.call(tokens, k)) {
          document.documentElement.style.setProperty(k, tokens[k]);
        }
      }
    }
    function arrancar(c) {
      ctx = c || null;
      aplicarTema(ctx);
      Promise.resolve()
        .then(function () { return GI.definirModo(); })
        .then(function () { GI.mostrarModo(); })
        .then(function () { return fn(ctx); })
        .catch(function (e) { GI.erroFatal(e); })
        .then(function () { GI.ajustarAltura(); });
    }
    if (global.omni && global.omni.ready) { omni.ready(arrancar); }
    else { setTimeout(function () { arrancar(null); }, 250); }

    global.addEventListener('message', function (ev) {
      var d = ev.data;
      if (Array.isArray(d) && d[0] === 'hello') { aplicarTema(d[1] || {}); }
    });
  };

  /* ------------------------------------------------------------------ altura */

  var ultimaAltura = 0;
  GI.ajustarAltura = function () {
    if (!global.omni || !omni.ui || !omni.ui.resize) return;
    var h = Math.max(document.documentElement.scrollHeight + 8, 520);
    if (Math.abs(h - ultimaAltura) < 12) return;
    ultimaAltura = h;
    var r = omni.ui.resize(h);           // recebe NÚMERO e rejeita promise
    if (r && r.catch) r.catch(function () {});
  };
  if (global.ResizeObserver) {
    new ResizeObserver(function () { GI.ajustarAltura(); }).observe(document.documentElement);
  }

  /* ------------------------------------------------------------------- aviso */

  GI.aviso = function (texto, tipo) {
    try { omni.ui.toast(String(texto), tipo || 'info'); }
    catch (e) { console.log('[GI]', tipo || 'info', texto); }
  };
  GI.erroFatal = function (e) {
    console.error('[GI]', e);
    var box = document.getElementById('gi-erro');
    if (box) {
      box.style.display = 'block';
      box.textContent = 'Falhou: ' + (e && e.message ? e.message : String(e));
    }
    GI.ajustarAltura();
  };

  /* --------------------------------------------------------------- guardados

     DOIS MODOS, e é aqui — e só aqui — que a diferença mora:

     • PORTAL  (config `portalUrl` + `portalToken` preenchidas): o dado vive no
       Postgres do portal, que é o MESMO banco que o MCP lê. Tela e IA passam a
       ver uma verdade só. É o modo de operação.
     • LOCAL   (config vazia): omni.storage, por usuário e por navegador. Serve
       para experimentar as telas sem servidor; o que se grava aqui NÃO chega à
       IA nem a mais ninguém.

     A tela diz em qual modo está, no rodapé — não se descobre isso por
     acidente. */

  var CHAVES = { campos: 'gi.campos', valores: 'gi.valores', historico: 'gi.historico' };

  GI.modo = 'local';
  GI.portalErro = '';

  function baseDoPortal() {
    var u = String(GI.cfg('portalUrl', '')).trim().replace(/\/+$/, '');
    return u ? u + '/api/ext' : '';
  }
  function tokenDoPortal() { return String(GI.cfg('portalToken', '')).trim(); }

  GI.usaPortal = function () { return !!(baseDoPortal() && tokenDoPortal()); };

  /* Como a chamada sai daqui, e por que NÃO é sempre fetch.
     A CSP do contêiner libera em connect-src apenas o origin de onde o HTML
     veio (aqui, o GitHub Pages) mais o da própria aplicação. O portal fica em
     outro domínio, então fetch direto é BLOQUEADO — e o erro que chega é só
     "Failed to fetch", sem dizer que foi a CSP.
     omni.http.request não tem esse problema: executa no backend da instância.
     Custa a cota de 30 req/min por usuário, o que sobra para telas de cadastro.
     O fetch continua sendo usado quando o portal serve o próprio HTML (mesma
     origem) — aí é mais rápido e não consome cota. */
  function mesmaOrigem() {
    try {
      var u = new URL(baseDoPortal());
      return u.origin === global.location.origin;
    } catch (e) { return false; }
  }

  function erroDe(status, corpo) {
    var dados = null;
    try { dados = corpo ? JSON.parse(corpo) : null; } catch (e) { /* não-JSON */ }
    var msg = (dados && dados.erro) ? dados.erro : ("HTTP " + status);
    if (status === 401) msg = "token do portal recusado";
    if (status === 403 && dados && dados.detalhe) msg = dados.detalhe;
    var err = new Error(msg);
    err.status = status;
    err.dados = dados;
    return err;
  }

  function cabecalhos(temCorpo) {
    var cab = {
      "Authorization": "Bearer " + tokenDoPortal(),
      "X-GI-Autor": GI.usuario(),
      "X-GI-User-Id": String((ctx && ctx.user && ctx.user.id) || "")
    };
    if (temCorpo) cab["Content-Type"] = "application/json";
    return cab;
  }

  function viaFetch(url, opcoes) {
    return fetch(url, {
      method: opcoes.corpo !== undefined ? "POST" : "GET",
      headers: cabecalhos(opcoes.corpo !== undefined),
      body: opcoes.corpo !== undefined ? JSON.stringify(opcoes.corpo) : undefined
    }).then(function (r) {
      return r.text().then(function (txt) {
        if (!r.ok) throw erroDe(r.status, txt);
        try { return txt ? JSON.parse(txt) : null; } catch (e) { return null; }
      });
    });
  }

  function viaOmni(url, opcoes) {
    if (!global.omni || !omni.http || !omni.http.request) {
      return Promise.reject(new Error("sem omni.http.request nesta instância"));
    }
    return Promise.resolve(omni.http.request({
      url: url,
      method: opcoes.corpo !== undefined ? "POST" : "GET",
      headers: cabecalhos(opcoes.corpo !== undefined),
      body: opcoes.corpo !== undefined ? JSON.stringify(opcoes.corpo) : undefined,
      timeout: 20000
    })).then(function (r) {
      // O body volta em TEXTO, sempre — o JSON.parse é nosso.
      if (!r || r.status < 200 || r.status >= 300) {
        throw erroDe(r ? r.status : 0, r && r.body);
      }
      try { return r.body ? JSON.parse(r.body) : null; } catch (e) { return null; }
    });
  }

  function chamar(caminho, opcoes) {
    opcoes = opcoes || {};
    var url = baseDoPortal() + caminho;
    return mesmaOrigem() ? viaFetch(url, opcoes) : viaOmni(url, opcoes);
  }
  GI.chamarPortal = chamar;

  function ler(chave, padrao) {
    if (!global.omni || !omni.storage) return Promise.resolve(padrao);
    return Promise.resolve(omni.storage.get(chave))
      .then(function (v) { return (v === undefined || v === null) ? padrao : v; })
      .catch(function () { return padrao; });
  }
  function gravar(chave, valor) {
    return Promise.resolve(omni.storage.set(chave, valor)).catch(function (e) {
      if (e && e.code === 'quota') {
        GI.aviso('Espaço do navegador cheio — nada foi gravado. Apague histórico antigo.', 'error');
      }
      throw e;
    });
  }

  /* Confere o portal uma vez, na montagem. Se ele não responder, a tela NÃO
     cai em silêncio para o storage local: ela avisa, porque trabalhar numa
     cópia que ninguém lê é pior do que não trabalhar. */
  GI.definirModo = function () {
    if (!GI.usaPortal()) { GI.modo = 'local'; return Promise.resolve('local'); }
    return chamar('/info').then(function () {
      GI.modo = 'portal';
      GI.portalErro = '';
      return 'portal';
    }).catch(function (e) {
      GI.modo = 'portal-fora';
      GI.portalErro = e && e.message ? e.message : String(e);
      return 'portal-fora';
    });
  };

  function exigePortal() {
    return Promise.reject(new Error(
      'O portal não respondeu (' + (GI.portalErro || 'sem detalhe') + '). ' +
      'Nada foi gravado — corrija a conexão antes de continuar.'));
  }

  GI.campos = function () {
    if (GI.modo === 'portal') return chamar('/campos?todos=1').then(function (r) { return paraCamposTela(r.campos); });
    if (GI.modo === 'portal-fora') return exigePortal();
    return ler(CHAVES.campos, []);
  };

  GI.salvarCampos = function (lista) {
    if (GI.modo !== 'portal') {
      if (GI.modo === 'portal-fora') return exigePortal();
      return gravar(CHAVES.campos, lista);
    }
    // No portal cada campo é uma linha: a tela usa GI.campoCriar/Atualizar/Apagar.
    return Promise.resolve();
  };

  GI.valores = function () {
    if (GI.modo === 'portal') return Promise.resolve({});   // o portal é consultado por imóvel
    if (GI.modo === 'portal-fora') return exigePortal();
    return ler(CHAVES.valores, {});
  };
  GI.salvarValores = function (mapa) {
    if (GI.modo === 'portal') return Promise.resolve();
    if (GI.modo === 'portal-fora') return exigePortal();
    return gravar(CHAVES.valores, mapa);
  };

  GI.historico = function (filtros) {
    if (GI.modo === 'portal') {
      var qs = [];
      filtros = filtros || {};
      if (filtros.codigo) qs.push('codigo=' + encodeURIComponent(filtros.codigo));
      if (filtros.quem) qs.push('quem=' + encodeURIComponent(filtros.quem));
      if (filtros.campo) qs.push('campo=' + encodeURIComponent(filtros.campo));
      return chamar('/historico' + (qs.length ? '?' + qs.join('&') : ''))
        .then(function (r) { return (r.eventos || []).map(paraEventoTela); });
    }
    if (GI.modo === 'portal-fora') return exigePortal();
    return ler(CHAVES.historico, []);
  };

  GI.registrarHistorico = function (eventos) {
    // No portal o histórico nasce de trigger no banco, com a autoria que veio
    // no cabeçalho: gravar daqui duplicaria cada linha.
    if (GI.modo === 'portal') return Promise.resolve();
    if (GI.modo === 'portal-fora') return exigePortal();
    if (!eventos || !eventos.length) return Promise.resolve();
    return ler(CHAVES.historico, []).then(function (lista) {
      var agora = new Date().toISOString();
      eventos.forEach(function (ev) {
        ev.quando = agora;
        ev.quem = GI.usuario();
        lista.unshift(ev);
      });
      return gravar(CHAVES.historico, lista.slice(0, 500));   // teto: o storage é finito
    });
  };

  /* --- tradução entre o formato do portal e o das telas -------------------
     O banco fala `rotulo`/`recorrencia_padrao`/`valor_centavos`; as telas
     falam `nome`/`recorrenciaPadrao`/`valor`. Traduzir num lugar só evita
     espalhar `campo.rotulo || campo.nome` por três arquivos. */

  var TIPO_DO_PORTAL = { valor: 'valor', numero: 'numero', texto: 'texto', selecao: 'selecao', checkbox: 'simnao' };
  var TIPO_PARA_PORTAL = { valor: 'valor', numero: 'numero', texto: 'texto', selecao: 'selecao', simnao: 'checkbox' };

  function paraCamposTela(lista) {
    return (lista || []).map(function (c) {
      return {
        id: c.id,
        nome: c.rotulo,
        tipo: TIPO_DO_PORTAL[c.tipo] || c.tipo,
        opcoes: c.opcoes || [],
        recorrenciaPadrao: c.recorrencia_padrao,
        ordem: c.ordem,
        ativo: c.ativo !== false,
        emUso: c.em_uso || 0
      };
    });
  }
  GI.tipoParaPortal = function (t) { return TIPO_PARA_PORTAL[t] || t; };

  /* O banco fala INSERT/UPDATE/DELETE e `valor_anterior`; a tela fala
     preencheu/alterou/removeu e `de`. */
  var ACAO = { INSERT: 'preencheu', UPDATE: 'alterou', DELETE: 'removeu' };

  function paraEventoTela(e) {
    return {
      quando: e.quando,
      quem: e.quem,
      codigo: e.codigo,
      campo: e.rotulo,
      acao: ACAO[e.operacao] || String(e.operacao || '').toLowerCase(),
      de: e.valor_anterior == null ? '' : String(e.valor_anterior),
      para: e.valor_novo == null ? '' : String(e.valor_novo)
    };
  }

  /* --- campos, no modo portal (uma linha por campo) ---------------------- */

  GI.campoCriar = function (campo) {
    return chamar('/campos', { corpo: {
      rotulo: campo.nome,
      tipo: GI.tipoParaPortal(campo.tipo),
      opcoes: campo.opcoes || [],
      recorrenciaPadrao: campo.recorrenciaPadrao || 'mes'
    } }).then(function (r) { return paraCamposTela(r.campos); });
  };

  GI.campoAtualizar = function (campo) {
    return chamar('/campos/' + campo.id, { corpo: {
      rotulo: campo.nome,
      tipo: GI.tipoParaPortal(campo.tipo),
      opcoes: campo.opcoes || [],
      recorrenciaPadrao: campo.recorrenciaPadrao || 'mes',
      ordem: campo.ordem || 100,
      ativo: campo.ativo !== false
    } }).then(function (r) { return paraCamposTela(r.campos); });
  };

  GI.campoApagar = function (id) {
    return chamar('/campos/' + id + '/apagar', { corpo: {} })
      .then(function (r) { return paraCamposTela(r.campos); });
  };

  /* --- lançamentos de um imóvel, no modo portal ------------------------- */

  GI.valoresDoImovel = function (codigo) {
    if (GI.modo !== 'portal') return GI.valores().then(function (m) { return m[codigo] || {}; });
    return chamar('/valores/' + encodeURIComponent(codigo)).then(function (r) {
      var saida = {};
      (r.valores || []).forEach(function (v) {
        if (v.valor_centavos == null && v.valor_num == null &&
            (v.valor_texto == null || v.valor_texto === '') && !v.observacao) return;
        saida[v.campo_id] = {
          valor: v.valor_centavos != null ? (Number(v.valor_centavos) / 100)
               : v.valor_num != null ? Number(v.valor_num)
               : (v.valor_texto || ''),
          obs: v.observacao || '',
          recorrencia: v.recorrencia || undefined
        };
      });
      return saida;
    });
  };

  GI.salvarValoresDoImovel = function (codigo, lancados, campos) {
    if (GI.modo !== 'portal') {
      return GI.valores().then(function (mapa) {
        if (Object.keys(lancados).length) mapa[codigo] = lancados;
        else delete mapa[codigo];
        return GI.salvarValores(mapa);
      });
    }
    /* Manda TODOS os campos ativos, inclusive os vazios: campo vazio é como o
       portal apaga um lançamento. Omitir os vazios deixaria valor velho vivo. */
    var entradas = (campos || []).filter(function (c) { return c.ativo !== false; }).map(function (c) {
      var l = lancados[c.id];
      var e = { campo_id: c.id, valor_centavos: null, valor_num: null,
                valor_texto: null, recorrencia: null, observacao: null };
      if (!l) return e;
      e.observacao = l.obs || null;
      if (c.tipo === 'valor') {
        if (l.valor !== '' && l.valor !== null && l.valor !== undefined) {
          e.valor_centavos = Math.round(Number(l.valor) * 100);
        }
        e.recorrencia = l.recorrencia || c.recorrenciaPadrao || 'unico';
      } else if (c.tipo === 'numero') {
        if (l.valor !== '' && l.valor !== null && l.valor !== undefined) e.valor_num = Number(l.valor);
      } else {
        if (l.valor !== '' && l.valor !== null && l.valor !== undefined) e.valor_texto = String(l.valor);
      }
      return e;
    });
    return chamar('/valores/' + encodeURIComponent(codigo), { corpo: { entradas: entradas } });
  };

  /* A tela Consultas saiu na 0.3.0. O registro de buscas deixou de ter leitor, então deixou
     de ser gravado — dado que ninguém lê é só consumo do orçamento do storage. */
  GI.registrarConsulta = function () { return Promise.resolve(); };

  GI.limpar = function (qual) {
    var chave = CHAVES[qual];
    if (!chave) return Promise.resolve();
    return gravar(chave, qual === 'valores' ? {} : []);
  };

  /* ---------------------------------------------------------------- catálogo
     omni.data.request aceita o NOME do recurso com query string (blueprint
     Sails). Se o where for recusado, cai para leitura paginada e filtro local:
     a tela continua funcionando, só mais devagar. */

  GI.estrategiaCatalogo = '';

  function pedir(recurso) {
    return omni.data.request(recurso, 'GET');
  }

  function montarWhere(filtros) {
    var marca = GI.cfg('marca', '');
    var where = {};
    if (marca) where.brand = marca;
    if (filtros.termo) {
      where.or = [
        { name: { contains: filtros.termo } },
        { internalcode: { contains: filtros.termo } },
        { category: { contains: filtros.termo } }
      ];
      if (marca) {
        where.or.forEach(function (o) { o.brand = marca; });
        delete where.brand;
      }
    }
    if (filtros.bairro) where.category = { contains: filtros.bairro };
    return where;
  }

  var cacheTudo = null;

  function carregarTudoLocal() {
    if (cacheTudo) return Promise.resolve(cacheTudo);
    var acumulado = [];
    function pagina(skip) {
      return pedir('products?limit=500&skip=' + skip).then(function (lote) {
        var arr = GI.lista(lote);
        acumulado = acumulado.concat(arr);
        if (arr.length === 500 && acumulado.length < 12000) return pagina(skip + 500);
        cacheTudo = acumulado;
        return acumulado;
      });
    }
    return pagina(0);
  }

  GI.lista = function (resposta) {
    if (Array.isArray(resposta)) return resposta;
    if (!resposta) return [];
    if (Array.isArray(resposta.products)) return resposta.products;
    if (Array.isArray(resposta.data)) return resposta.data;
    if (Array.isArray(resposta.items)) return resposta.items;
    return [];
  };

  function casaLocal(p, filtros) {
    var marca = GI.cfg('marca', '');
    if (marca && String(p.brand || '') !== marca) return false;
    if (filtros.bairro && String(p.category || '').toLowerCase().indexOf(String(filtros.bairro).toLowerCase()) === -1) return false;
    if (filtros.termo) {
      var t = String(filtros.termo).toLowerCase();
      var alvo = (String(p.name || '') + ' ' + String(p.internalcode || '') + ' ' + String(p.category || '')).toLowerCase();
      if (alvo.indexOf(t) === -1) return false;
    }
    return true;
  }

  GI.buscarImoveis = function (filtros) {
    filtros = filtros || {};
    var porPagina = filtros.porPagina || 25;
    var skip = ((filtros.pagina || 1) - 1) * porPagina;
    var inicio = Date.now();

    var recurso = 'products?where=' + encodeURIComponent(JSON.stringify(montarWhere(filtros))) +
                  '&limit=' + porPagina + '&skip=' + skip + '&sort=' + encodeURIComponent('id ASC');

    return pedir(recurso).then(function (r) {
      var arr = GI.lista(r);
      GI.estrategiaCatalogo = 'consulta filtrada no servidor';
      return { itens: arr, total: null, ms: Date.now() - inicio };
    }).catch(function () {
      return carregarTudoLocal().then(function (todos) {
        GI.estrategiaCatalogo = 'catálogo lido inteiro e filtrado na tela';
        var filtrados = todos.filter(function (p) { return casaLocal(p, filtros); });
        return {
          itens: filtrados.slice(skip, skip + porPagina),
          total: filtrados.length,
          ms: Date.now() - inicio
        };
      });
    });
  };

  GI.buscarImovel = function (codigo) {
    var recurso = 'products?where=' + encodeURIComponent(JSON.stringify({ internalcode: String(codigo) })) + '&limit=1';
    return pedir(recurso).then(function (r) {
      var arr = GI.lista(r);
      if (arr.length) return arr[0];
      throw new Error('vazio');
    }).catch(function () {
      return carregarTudoLocal().then(function (todos) {
        var achado = todos.filter(function (p) { return String(p.internalcode) === String(codigo); })[0];
        if (!achado) throw new Error('imóvel ' + codigo + ' não está no catálogo');
        return achado;
      });
    });
  };

  /* ------------------------------------------------------------- formatação */

  GI.codigoCurto = function (internalcode) {
    var pre = String(GI.cfg('prefixoCodigo', ''));
    var cod = String(internalcode || '');
    return (pre && cod.indexOf(pre) === 0) ? cod.slice(pre.length) : cod;
  };

  GI.partesCategoria = function (categoria) {
    var p = String(categoria || '').split('>').map(function (x) { return x.trim(); });
    return { tipo: p[0] || '', cidade: p[1] || '', bairro: p[2] || '' };
  };

  GI.dinheiro = function (centavos) {
    var n = Number(centavos || 0) / 100;
    return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  };

  GI.dataHora = function (iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  };

  GI.escapar = function (s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };

  /* ------------------------------------------------- campos e valor legível */

  GI.TIPOS = [
    { id: 'valor',   nome: 'Valor (R$)',      ajuda: 'aceita recorrência: /mês, /ano…' },
    { id: 'numero',  nome: 'Número',          ajuda: 'quantidade, metragem' },
    { id: 'texto',   nome: 'Texto livre',     ajuda: 'observação da administração' },
    { id: 'selecao', nome: 'Seleção (lista)', ajuda: 'exige ao menos uma opção' },
    { id: 'simnao',  nome: 'Sim / Não',       ajuda: '' }
  ];

  GI.RECORRENCIAS = [
    { id: 'unico',  nome: 'único',      sufixo: '' },
    { id: 'dia',    nome: 'por dia',    sufixo: '/dia' },
    { id: 'semana', nome: 'por semana', sufixo: '/semana' },
    { id: 'mes',    nome: 'por mês',    sufixo: '/mês' },
    { id: 'ano',    nome: 'por ano',    sufixo: '/ano' }
  ];

  GI.nomeTipo = function (id) {
    var t = GI.TIPOS.filter(function (x) { return x.id === id; })[0];
    return t ? t.nome : id;
  };
  GI.sufixoRecorrencia = function (id) {
    var r = GI.RECORRENCIAS.filter(function (x) { return x.id === id; })[0];
    return r ? r.sufixo : '';
  };

  /* Mesma regra do portal: 0 é "isento"; vazio com observação é
     "consultar com o consultor"; vazio sem observação não existe. */
  GI.valorLegivel = function (campo, lancamento) {
    if (!campo || !lancamento) return '';
    var obs = String(lancamento.obs || '').trim();
    if (campo.tipo === 'valor') {
      if (lancamento.valor === '' || lancamento.valor === null || lancamento.valor === undefined) {
        return obs ? obs : 'consultar com o consultor';
      }
      var n = Number(lancamento.valor);
      if (n === 0) return 'isento' + (obs ? ' — ' + obs : '');
      return GI.dinheiro(Math.round(n * 100)) + GI.sufixoRecorrencia(lancamento.recorrencia) + (obs ? ' — ' + obs : '');
    }
    var bruto = lancamento.valor;
    if (bruto === '' || bruto === null || bruto === undefined) return obs || '';
    if (campo.tipo === 'simnao') bruto = (String(bruto) === 'sim') ? 'sim' : 'não';
    return String(bruto) + (obs ? ' — ' + obs : '');
  };

  GI.numeroValido = function (texto) {
    if (texto === '' || texto === null || texto === undefined) return true;
    return /^-?\d{1,12}([.,]\d{1,2})?$/.test(String(texto).trim());
  };
  GI.paraNumero = function (texto) {
    if (texto === '' || texto === null || texto === undefined) return '';
    return Number(String(texto).trim().replace(/\./g, '').replace(',', '.'));
  };

  /* -------------------------------------------------------------- navegação */

  GI.abrirTela = function (contributionId) {
    try {
      var r = omni.ui.openContribution(contributionId);
      if (r && r.catch) r.catch(function () { GI.aviso('Abra pelo menu Gerenciamento de Imóveis.', 'info'); });
    } catch (e) { GI.aviso('Abra pelo menu Gerenciamento de Imóveis.', 'info'); }
  };

  /* A tela precisa dizer onde está gravando. Uma pessoa preenchendo 40 imóveis
     num storage que ninguém lê perde o trabalho inteiro em silêncio. */
  GI.mostrarModo = function () {
    var alvo = document.getElementById('gi-modo');
    if (!alvo) return;
    if (GI.modo === 'portal') {
      alvo.innerHTML = '🟢 <strong>Conectado ao portal</strong> — o que você grava aqui é o que a ' +
        'assistente de IA responde ao cliente.';
    } else if (GI.modo === 'portal-fora') {
      alvo.innerHTML = '🔴 <strong>O portal não respondeu</strong> (' + GI.escapar(GI.portalErro) + '). ' +
        'Nada será gravado até a conexão voltar — avise o suporte antes de continuar.';
    } else {
      alvo.innerHTML = '🟡 <strong>Modo local</strong> — sem portal configurado, o que você preencher fica ' +
        'só no seu navegador e <strong>não chega à IA</strong>. Para valer, preencha a URL e o token do ' +
        'portal na instalação da extensão.';
    }
    GI.ajustarAltura();
  };

  GI.cabecalho = function (ativo) {
    var telas = [
      { id: 'gi-imoveis',   nome: 'Imóveis' },
      { id: 'gi-campos',    nome: 'Campos' },
      { id: 'gi-historico', nome: 'Histórico' }
    ];
    return '<nav class="gi-nav">' + telas.map(function (t) {
      return t.id === ativo
        ? '<span class="gi-nav-item gi-nav-ativo">' + t.nome + '</span>'
        : '<button type="button" class="gi-nav-item" data-tela="' + t.id + '">' + t.nome + '</button>';
    }).join('') + '</nav>';
  };

  GI.ligarNavegacao = function (raiz) {
    var nos = (raiz || document).querySelectorAll('[data-tela]');
    Array.prototype.forEach.call(nos, function (b) {
      b.addEventListener('click', function () { GI.abrirTela(b.getAttribute('data-tela')); });
    });
  };

  global.GI = GI;
})(window);
