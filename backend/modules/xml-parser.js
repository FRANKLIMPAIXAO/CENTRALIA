'use strict';

const { XMLParser } = require('fast-xml-parser');

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  allowBooleanAttributes: true,
  parseAttributeValue: true,
  trimValues: true
});

/* ══════════════════════════════════════════
   DETECTOR DE TIPO DE XML FISCAL
══════════════════════════════════════════ */
function detectDocType(xmlStr) {
  if (xmlStr.includes('<nfeProc') || xmlStr.includes('<NFe ') || xmlStr.includes('<infNFe'))   return 'NFe';
  if (xmlStr.includes('<nfseProc') || xmlStr.includes('<CompNfse') || xmlStr.includes('<Nfse')) return 'NFSe';
  if (xmlStr.includes('<cteProc') || xmlStr.includes('<CTe ') || xmlStr.includes('<infCte'))   return 'CTe';
  if (xmlStr.includes('<eSocial'))  return 'eSocial';
  if (xmlStr.includes('<EFD'))      return 'EFD';
  if (xmlStr.includes('<Reinf'))    return 'EFD-Reinf';
  return 'XML_DESCONHECIDO';
}

/* ══════════════════════════════════════════
   PARSER NFe — Nota Fiscal Eletrônica
══════════════════════════════════════════ */
function parseNFe(xml) {
  const root  = xml.nfeProc || xml.NFe || xml;
  const nfe   = root.NFe || root;
  const inf   = nfe.infNFe || nfe;

  const emit  = inf.emit  || {};
  const dest  = inf.dest  || {};
  const total = inf.total?.ICMSTot || {};
  const ide   = inf.ide   || {};
  const cobr  = inf.cobr  || {};
  const transp= inf.transp|| {};

  // Itens
  const detRaw = inf.det || [];
  const itens  = (Array.isArray(detRaw) ? detRaw : [detRaw]).map(d => {
    const prod  = d.prod  || {};
    const imposto = d.imposto || {};
    const icms  = imposto.ICMS || {};
    const icmsGrupo = icms[Object.keys(icms)[0]] || {};
    const pis   = imposto.PIS?.PISAliq || imposto.PIS?.PISNT || {};
    const cofins= imposto.COFINS?.COFINSAliq || imposto.COFINS?.COFINSNT || {};

    return {
      numero      : d['@_nItem'],
      codigo      : prod.cProd,
      descricao   : prod.xProd,
      ncm         : prod.NCM,
      cfop        : prod.CFOP,
      unidade     : prod.uCom,
      quantidade  : parseFloat(prod.qCom) || 0,
      valorUnit   : parseFloat(prod.vUnCom) || 0,
      valorTotal  : parseFloat(prod.vProd) || 0,
      desconto    : parseFloat(prod.vDesc) || 0,
      icms: {
        cst       : icmsGrupo.CST || icmsGrupo.CSOSN,
        base      : parseFloat(icmsGrupo.vBC) || 0,
        aliquota  : parseFloat(icmsGrupo.pICMS) || 0,
        valor     : parseFloat(icmsGrupo.vICMS) || 0,
        reducao   : parseFloat(icmsGrupo.pRedBC) || 0
      },
      pis: {
        cst       : pis.CST,
        aliquota  : parseFloat(pis.pPIS) || 0,
        valor     : parseFloat(pis.vPIS) || 0
      },
      cofins: {
        cst       : cofins.CST,
        aliquota  : parseFloat(cofins.pCOFINS) || 0,
        valor     : parseFloat(cofins.vCOFINS) || 0
      }
    };
  });

  // Duplicatas (vencimentos)
  const dupRaw = cobr.dup || [];
  const duplicatas = (Array.isArray(dupRaw) ? dupRaw : [dupRaw]).map(d => ({
    numero    : d.nDup,
    vencimento: d.dVenc,
    valor     : parseFloat(d.vDup) || 0
  }));

  return {
    tipo       : 'NFe',
    chave      : inf['@_Id']?.replace('NFe', '') || '',
    numero     : ide.nNF,
    serie      : ide.serie,
    dataEmissao: ide.dhEmi || ide.dEmi,
    natureza   : ide.natOp,
    finalidade : ide.finNFe, // 1=Normal, 2=Complementar, 3=Ajuste, 4=Devolução
    tipoEmissao: ide.tpEmis,
    ambiente   : ide.tpAmb  === 1 ? 'Produção' : 'Homologação',
    emitente: {
      cnpj   : emit.CNPJ,
      cpf    : emit.CPF,
      nome   : emit.xNome,
      fantasia: emit.xFant,
      ie     : emit.IE,
      crt    : emit.CRT, // 1=Simples, 2=Simples Excesso, 3=Normal
      uf     : emit.enderEmit?.UF,
      municipio: emit.enderEmit?.xMun
    },
    destinatario: {
      cnpj   : dest.CNPJ,
      cpf    : dest.CPF,
      nome   : dest.xNome,
      ie     : dest.IE,
      uf     : dest.enderDest?.UF,
      municipio: dest.enderDest?.xMun,
      email  : dest.email
    },
    transporte: {
      modalidade: transp.modFrete, // 0=CIF, 1=FOB, 2=Terceiros, 3=Próprio/Rem, 4=Próprio/Dest, 9=Sem
      transportadora: transp.transporta?.xNome
    },
    totais: {
      baseICMS    : parseFloat(total.vBC)    || 0,
      valorICMS   : parseFloat(total.vICMS)  || 0,
      icmsDeson   : parseFloat(total.vICMSDeson) || 0,
      baseICMSST  : parseFloat(total.vBCST)  || 0,
      valorICMSST : parseFloat(total.vST)    || 0,
      valorProdutos: parseFloat(total.vProd) || 0,
      valorFrete  : parseFloat(total.vFrete) || 0,
      valorSeguro : parseFloat(total.vSeg)   || 0,
      desconto    : parseFloat(total.vDesc)  || 0,
      outrasDespesas: parseFloat(total.vOutro) || 0,
      valorIPI    : parseFloat(total.vIPI)   || 0,
      valorPIS    : parseFloat(total.vPIS)   || 0,
      valorCOFINS : parseFloat(total.vCOFINS)|| 0,
      valorNF     : parseFloat(total.vNF)    || 0
    },
    itens,
    duplicatas,
    protocolo  : root.protNFe?.infProt?.nProt || ''
  };
}

/* ══════════════════════════════════════════
   PARSER NFSe — Nota Fiscal de Serviço
══════════════════════════════════════════ */
function parseNFSe(xml) {
  // NFSe não tem padrão único — suporte ao padrão ABRASF (mais comum)
  const comp   = xml.CompNfse || xml.nfseProc || xml;
  const nfse   = comp.Nfse?.InfNfse || comp.Nfse || comp;
  const serv   = nfse.Servico || {};
  const prest  = nfse.PrestadorServico || {};
  const tom    = nfse.TomadorServico   || {};
  const val    = serv.Valores || {};

  return {
    tipo           : 'NFSe',
    numero         : nfse.Numero,
    competencia    : nfse.Competencia,
    dataEmissao    : nfse.DataEmissao,
    natureza       : nfse.NaturezaOperacao,
    prestador: {
      cnpj         : prest.IdentificacaoPrestador?.CpfCnpj?.Cnpj,
      razaoSocial  : prest.RazaoSocial,
      municipio    : prest.Endereco?.Municipio
    },
    tomador: {
      cnpj         : tom.IdentificacaoTomador?.CpfCnpj?.Cnpj,
      cpf          : tom.IdentificacaoTomador?.CpfCnpj?.Cpf,
      razaoSocial  : tom.RazaoSocial,
      email        : tom.Contato?.Email
    },
    servico: {
      discriminacao: serv.Discriminacao,
      municipio    : serv.CodigoMunicipio,
      itemLista    : serv.ItemListaServico,
      cnae         : serv.CodigoCnae
    },
    valores: {
      servicos     : parseFloat(val.ValorServicos)     || 0,
      deducoes     : parseFloat(val.ValorDeducoes)     || 0,
      baseCalculo  : parseFloat(val.BaseCalculo)       || 0,
      aliquotaISS  : parseFloat(val.Aliquota)          || 0,
      valorISS     : parseFloat(val.ValorIss)          || 0,
      valorISSRetido: parseFloat(val.ValorIssRetido)   || 0,
      valorLiquido : parseFloat(val.ValorLiquidoNfse)  || 0,
      ir           : parseFloat(val.ValorIr)           || 0,
      csll         : parseFloat(val.ValorCsll)         || 0,
      pis          : parseFloat(val.ValorPis)          || 0,
      cofins       : parseFloat(val.ValorCofins)       || 0,
      inss         : parseFloat(val.ValorInss)         || 0
    }
  };
}

/* ══════════════════════════════════════════
   PARSER CTe — Conhecimento de Transporte
══════════════════════════════════════════ */
function parseCTe(xml) {
  const root  = xml.cteProc || xml.CTe || xml;
  const cte   = root.CTe   || root;
  const inf   = cte.infCte || cte;
  const ide   = inf.ide    || {};
  const emit  = inf.emit   || {};
  const rem   = inf.rem    || {};
  const dest  = inf.dest   || {};
  const vPrest= inf.vPrest || {};
  const imp   = inf.imp    || {};
  const icms  = imp.ICMS   || {};
  const icmsGrupo = icms[Object.keys(icms)[0]] || {};

  return {
    tipo       : 'CTe',
    chave      : inf['@_Id']?.replace('CTe', '') || '',
    numero     : ide.nCT,
    serie      : ide.serie,
    dataEmissao: ide.dhEmi,
    cfop       : ide.CFOP,
    natureza   : ide.natOp,
    ambiente   : ide.tpAmb === 1 ? 'Produção' : 'Homologação',
    modal      : ide.modal, // 01=Rodoviário, 02=Aéreo, 03=Aquaviário, 04=Ferroviário
    emitente: {
      cnpj   : emit.CNPJ,
      nome   : emit.xNome,
      ie     : emit.IE,
      uf     : emit.enderEmit?.UF
    },
    remetente: {
      cnpj   : rem.CNPJ,
      cpf    : rem.CPF,
      nome   : rem.xNome
    },
    destinatario: {
      cnpj   : dest.CNPJ,
      cpf    : dest.CPF,
      nome   : dest.xNome
    },
    valores: {
      totalPrestacao : parseFloat(vPrest.vTPrest) || 0,
      receber        : parseFloat(vPrest.vRec)    || 0
    },
    icms: {
      base     : parseFloat(icmsGrupo.vBC)   || 0,
      aliquota : parseFloat(icmsGrupo.pICMS) || 0,
      valor    : parseFloat(icmsGrupo.vICMS) || 0,
      cst      : icmsGrupo.CST
    }
  };
}

/* ══════════════════════════════════════════
   FUNÇÃO PRINCIPAL — parse qualquer XML fiscal
══════════════════════════════════════════ */
function parseFiscalXML(xmlString) {
  let xml;
  try {
    xml = parser.parse(xmlString);
  } catch (err) {
    throw new Error('XML inválido ou corrompido: ' + err.message);
  }

  const tipo = detectDocType(xmlString);

  switch (tipo) {
    case 'NFe':    return parseNFe(xml);
    case 'NFSe':   return parseNFSe(xml);
    case 'CTe':    return parseCTe(xml);
    default:
      return { tipo, raw: xml, aviso: 'Tipo de documento ainda sem parser especializado.' };
  }
}

/* ══════════════════════════════════════════
   HELPERS DE FORMATAÇÃO
══════════════════════════════════════════ */
function formatCurrency(v) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v || 0);
}

function formatPercent(v) {
  return `${(v || 0).toFixed(2).replace('.', ',')}%`;
}

function crtLabel(crt) {
  return { 1: 'Simples Nacional', 2: 'Simples Nacional - Excesso', 3: 'Regime Normal' }[crt] || 'Não identificado';
}

function finalidadeLabel(f) {
  return { 1: 'Normal', 2: 'Complementar', 3: 'Ajuste', 4: 'Devolução/Retorno' }[f] || 'Normal';
}

module.exports = { parseFiscalXML, detectDocType, formatCurrency, formatPercent, crtLabel, finalidadeLabel };
