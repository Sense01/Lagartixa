/* =========================================================
   Tradução automática das palavras-chave (PT · FR · ES · DE)
   "adaptador" passa a procurar também "adaptateur" e "adapter",
   para apanhar os mesmos produtos nas lojas dos outros países.

   Ordem: 1. dicionário abaixo (imediato, sem rede)
          2. traduções já pedidas à IA (guardadas no aparelho)
          3. IA através do teu Worker (POST /translate), uma vez por termo
          4. sem Worker: tradução palavra a palavra com o dicionário
   ========================================================= */

const Translate = (() => {
  const LANGS = ['pt', 'fr', 'es', 'de'];

  // uma linha por conceito: pt ; fr ; es ; de  (alternativas separadas por |)
  const DICT = `
    adaptador ; adaptateur ; adaptador ; adapter
    cabo ; câble ; cable ; kabel
    carregador ; chargeur ; cargador ; ladegerät|netzteil
    rato ; souris ; ratón ; maus
    teclado ; clavier ; teclado ; tastatur
    monitor ; écran|moniteur ; monitor ; monitor|bildschirm
    portátil ; ordinateur portable|pc portable ; portátil ; laptop|notebook
    computador ; ordinateur ; ordenador ; computer
    impressora ; imprimante ; impresora ; drucker
    impressora 3d ; imprimante 3d ; impresora 3d ; 3d-drucker
    filamento ; filament ; filamento ; filament
    tinteiro ; cartouche d'encre|cartouche ; cartucho de tinta|cartucho ; tintenpatrone|druckerpatrone
    disco rígido ; disque dur ; disco duro ; festplatte
    disco externo ; disque dur externe ; disco duro externo ; externe festplatte
    memória ram ; mémoire ram|barrette mémoire ; memoria ram ; arbeitsspeicher
    placa gráfica ; carte graphique ; tarjeta gráfica ; grafikkarte
    placa-mãe|motherboard ; carte mère ; placa base ; mainboard|motherboard
    processador ; processeur ; procesador ; prozessor
    fonte de alimentação ; alimentation ; fuente de alimentación ; netzteil
    caixa pc ; boîtier pc ; caja pc ; pc-gehäuse|gehäuse
    ventoinha|ventilador ; ventilateur ; ventilador ; lüfter|ventilator
    pasta térmica ; pâte thermique ; pasta térmica ; wärmeleitpaste
    auscultadores|auriculares ; casque|écouteurs ; auriculares|cascos ; kopfhörer
    coluna ; enceinte|haut-parleur ; altavoz ; lautsprecher
    microfone ; microphone ; micrófono ; mikrofon
    router ; routeur ; router ; router
    tablet ; tablette ; tablet|tableta ; tablet
    telemóvel|smartphone ; téléphone|smartphone ; móvil|smartphone ; handy|smartphone
    capa ; coque|étui ; funda ; hülle|handyhülle
    película ; protection écran|verre trempé ; protector de pantalla|cristal templado ; schutzfolie|panzerglas
    bateria ; batterie ; batería ; akku|batterie
    pilha ; pile ; pila ; batterie
    powerbank ; batterie externe ; batería externa|powerbank ; powerbank
    pen usb|pen drive ; clé usb ; pendrive|memoria usb ; usb-stick
    cartão de memória ; carte mémoire ; tarjeta de memoria ; speicherkarte
    extensão ; multiprise|rallonge ; regleta|alargador ; steckdosenleiste|verlängerungskabel
    suporte ; support ; soporte ; halterung|ständer
    televisão|televisor|tv ; télévision|téléviseur|tv ; televisor|televisión|tv ; fernseher|tv
    comando ; télécommande ; mando ; fernbedienung
    controlador|gamepad ; manette ; mando|gamepad ; controller|gamepad
    consola ; console ; consola ; konsole|spielkonsole
    jogo ; jeu|jeux ; juego ; spiel
    jogo de tabuleiro ; jeu de société ; juego de mesa ; brettspiel
    câmara ; appareil photo|caméra ; cámara ; kamera
    relógio ; montre ; reloj ; uhr
    cadeira ; chaise ; silla ; stuhl
    cadeira gaming ; chaise gaming|fauteuil gamer ; silla gaming ; gaming-stuhl|gamingstuhl
    secretária ; bureau ; escritorio ; schreibtisch
    candeeiro ; lampe ; lámpara ; lampe
    lâmpada ; ampoule ; bombilla ; glühbirne|leuchtmittel
    brinquedo ; jouet ; juguete ; spielzeug
    boneca ; poupée ; muñeca ; puppe
    peluche ; peluche ; peluche ; kuscheltier|plüschtier
    puzzle ; puzzle ; puzzle|rompecabezas ; puzzle
    carro telecomandado ; voiture télécommandée ; coche teledirigido ; ferngesteuertes auto
    bicicleta ; vélo ; bicicleta ; fahrrad
    trotinete ; trottinette ; patinete ; roller|e-scooter
    livro ; livre ; libro ; buch
    mochila ; sac à dos ; mochila ; rucksack
    mala ; valise ; maleta ; koffer
    frigorífico ; réfrigérateur|frigo ; frigorífico|nevera ; kühlschrank
    congelador|arca congeladora ; congélateur ; congelador ; gefrierschrank
    máquina de lavar roupa ; lave-linge|machine à laver ; lavadora ; waschmaschine
    máquina de secar roupa|secador de roupa ; sèche-linge ; secadora ; trockner|wäschetrockner
    máquina de lavar loiça ; lave-vaisselle ; lavavajillas ; geschirrspüler|spülmaschine
    forno ; four ; horno ; backofen
    micro-ondas|microondas ; micro-ondes ; microondas ; mikrowelle
    placa de indução ; plaque induction|plaque à induction ; placa de inducción ; induktionskochfeld
    exaustor ; hotte ; campana extractora ; dunstabzugshaube
    aspirador ; aspirateur ; aspiradora|aspirador ; staubsauger
    aspirador robô|robot aspirador ; aspirateur robot ; robot aspirador ; saugroboter
    ferro de engomar ; fer à repasser ; plancha ; bügeleisen
    máquina de café ; machine à café|cafetière ; cafetera ; kaffeemaschine
    chaleira ; bouilloire ; hervidor ; wasserkocher
    torradeira ; grille-pain ; tostadora ; toaster
    liquidificadora ; blender|mixeur ; batidora ; mixer|standmixer
    fritadeira|air fryer ; friteuse ; freidora ; fritteuse|heißluftfritteuse
    ar condicionado ; climatiseur ; aire acondicionado ; klimaanlage|klimagerät
    aquecedor ; radiateur|chauffage ; calefactor|estufa ; heizgerät|heizlüfter
    desumidificador ; déshumidificateur ; deshumidificador ; luftentfeuchter
    secador de cabelo ; sèche-cheveux ; secador de pelo ; haartrockner|föhn
    máquina de barbear ; rasoir ; afeitadora ; rasierer
    escova de dentes ; brosse à dents ; cepillo de dientes ; zahnbürste
    balança ; balance ; báscula ; waage
    berbequim ; perceuse ; taladro ; bohrmaschine
    aparafusadora ; visseuse ; atornillador ; akkuschrauber
    serra ; scie ; sierra ; säge
    martelo ; marteau ; martillo ; hammer
    chave de fendas ; tournevis ; destornillador ; schraubendreher
    ferramenta ; outil|outils ; herramienta ; werkzeug
    tinta ; peinture ; pintura ; farbe
    escada|escadote ; échelle|escabeau ; escalera ; leiter
    corta-relva|cortador de relva ; tondeuse ; cortacésped ; rasenmäher
    mangueira ; tuyau d'arrosage ; manguera ; gartenschlauch
    colchão ; matelas ; colchón ; matratze
    almofada ; oreiller|coussin ; almohada|cojín ; kissen
    sofá ; canapé ; sofá ; sofa
    mesa ; table ; mesa ; tisch
    cama ; lit ; cama ; bett
    armário ; armoire ; armario ; schrank
    estante ; étagère ; estantería ; regal
    tapete ; tapis ; alfombra ; teppich
    panela ; casserole ; olla ; topf
    frigideira ; poêle ; sartén ; pfanne
    faca ; couteau ; cuchillo ; messer
    sapatilhas|ténis ; baskets|chaussures ; zapatillas ; sneaker|schuhe
    casaco ; veste|manteau ; chaqueta|abrigo ; jacke
    óculos ; lunettes ; gafas ; brille
    perfume ; parfum ; perfume ; parfum|parfüm
  `.trim().split('\n').map((line) => line.split(';').map((cell) => cell.trim().split('|').map((x) => x.trim())));

  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

  // índice: qualquer forma, em qualquer das 4 línguas -> linha do dicionário (a primeira ganha)
  const index = new Map();
  DICT.forEach((row, i) => row.forEach((cell) => cell.forEach((w) => { if (!index.has(norm(w))) index.set(norm(w), i); })));

  /** linha do dicionário para um termo (aceita plurais simples: "adaptadores", "cabos") */
  function rowOf(term) {
    const n = norm(term);
    for (const k of [n, n.replace(/s$/, ''), n.replace(/es$/, '')]) if (index.has(k)) return DICT[index.get(k)];
    return null;
  }
  const fromRow = (row) => Object.fromEntries(LANGS.map((l, i) => [l, row[i]]));

  /* ---------- traduções da IA guardadas no aparelho ---------- */
  const KEY = ((typeof window !== 'undefined' && window.STORE_PREFIX) || '') + 'crawler-translate';
  let cache = null;
  function saved() {
    if (!cache) { try { cache = JSON.parse(localStorage.getItem(KEY)) || {}; } catch { cache = {}; } }
    return cache;
  }
  function remember(term, tr) {
    const c = saved();
    c[norm(term)] = tr;
    const keys = Object.keys(c);
    if (keys.length > 500) keys.slice(0, keys.length - 500).forEach((k) => delete c[k]);
    try { localStorage.setItem(KEY, JSON.stringify(c)); } catch {}
  }

  /** várias palavras ("cabo hdmi"): traduz as que o dicionário conhece e mantém as outras (marcas, modelos) */
  function wordwise(term) {
    const words = String(term).trim().split(/\s+/);
    if (words.length < 2) return null;
    let hit = false;
    const out = {};
    LANGS.forEach((l, i) => {
      out[l] = [words.map((w) => { const r = rowOf(w); if (r) hit = true; return r ? r[i][0] : w; }).join(' ')];
    });
    return hit ? out : null;
  }

  /** só vale a pena traduzir termos com palavras a sério (não "RTX 5070", "USB" nem "40460") */
  const translatable = (term) => String(term).split(/\s+/).some((w) => /^[\p{L}-]{3,}$/u.test(w) && w !== w.toUpperCase());

  function resolve(term) {
    const row = rowOf(term);
    if (row) return { tr: fromRow(row), how: 'dict' };
    const c = saved()[norm(term)];
    if (c) return { tr: c, how: 'ia' };
    const w = wordwise(term);
    return w ? { tr: w, how: 'words' } : { tr: null, how: null };
  }

  /** lista final: cada termo seguido das traduções (sem repetidos; formas sem acento incluídas para os endereços) */
  function build(terms) {
    const all = [], seen = new Set(), groups = [];
    const add = (t) => { const k = String(t).toLowerCase().trim(); if (!k || seen.has(k)) return false; seen.add(k); all.push(String(t).trim()); return true; };
    for (const term of terms) {
      add(term);
      const { tr, how } = resolve(term);
      const added = [];
      if (tr) for (const l of LANGS) for (const t of tr[l] || []) {
        if (norm(t) === norm(term)) continue;          // igual ao que o utilizador escreveu (tirando acentos)
        if (add(t)) added.push(t);
        const plain = t.normalize('NFD').replace(/[̀-ͯ]/g, '');
        if (plain !== t) add(plain);
      }
      groups.push({ term, added, how });
    }
    return { all, groups };
  }

  /** sem rede: dicionário + traduções já guardadas */
  const expandSync = (terms) => build((terms || []).map((t) => String(t).trim()).filter(Boolean));

  async function askWorker(terms) {
    const base = typeof workerBase === 'function' ? workerBase() : null;
    if (!base) return {};
    const res = await fetch(base + '/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...workerHeaders() },
      body: JSON.stringify({ terms }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()).translations || {};
  }

  /** com rede: os termos que o dicionário não conhece são pedidos à IA (uma vez; depois ficam guardados) */
  async function expand(terms, { ask = askWorker } = {}) {
    const list = (terms || []).map((t) => String(t).trim()).filter(Boolean);
    const pending = list.filter((t) => translatable(t) && !rowOf(t) && !saved()[norm(t)]).slice(0, 12);
    if (pending.length) {
      try {
        const got = await ask(pending);
        for (const t of pending) {
          const tr = got[t] || got[norm(t)];
          if (!tr || typeof tr !== 'object') continue;
          const clean = Object.fromEntries(LANGS.map((l) => [l, (Array.isArray(tr[l]) ? tr[l] : []).map((x) => String(x).trim()).filter((x) => x && x.length <= 60).slice(0, 3)]));
          remember(t, clean);
        }
      } catch { /* sem Worker ou sem IA: fica o dicionário */ }
    }
    return build(list);
  }

  return { expand, expandSync, rowOf, LANGS, _reset: () => { cache = null; } };
})();
