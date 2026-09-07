(function (root) {
  'use strict';
  function vehicleName(value) {
    let name = String(value || '').normalize('NFKC').trim().replace(/[_\s]+/g, ' ');
    name = name.replace(/^Mercedes[- ]Benz\s+(?:mercedes[- ]benz\s+)+/i, 'Mercedes-Benz ')
      .replace(/^Mos[kc](?:v|w)ich\b/i, 'Moskvich')
      .replace(/\b(\d)er\b/gi, '$1 Series').replace(/\b([1-8]) series\b/gi, '$1 Series')
      .replace(/activetourer/gi, 'Active Tourer').replace(/grancoupe/gi, 'Gran Coupe')
      .replace(/(granta|vesta|kalina|priora)(hybrid|sw|sport|cross)/gi, '$1 $2')
      .replace(/(\d)(classic|niva|active|gran)/gi, '$1 $2')
      .replace(/\b([acegs])[- ]class\b/gi, (_, letter) => letter.toUpperCase() + '-Class');
    const acronyms = new Set(['bmw','mini','lada','uaz','gaz','gmc','byd','mg','ds','amg','gt','gti','gtd','gtr','rs','rsx','nsx','tsx','ilx','mdx','rdx','cdx','suv','ev','sw','jcw','sti','ts','tdi','tsi','tfsi','srt','glc','gle','gls','cla','cls','sl','slk','slc','eqc','eqe','eqs','lfa','vx','rx','cx','tx','lx','ls','is','es','gs','ct','nx','ux']);
    name = name.replace(/\bBeijingbj/gi, 'Beijing BJ').replace(/\b(rs|rx|cx|nx|ux|lx|gl|q|x|j) (\d+)\b/gi, (_, code, number) => code.toUpperCase() + number);
    name = name.split(' ').map((word, index) => {
      const lower = word.toLowerCase();
      if (index === 0 && /^[A-Z]{2,5}$/.test(word)) return word;
      if (acronyms.has(lower) || /^(?:[ivx]+|[a-z]{1,3}\d[a-z\d-]*)$/i.test(word) || /^\([a-z\d]+\)$/i.test(word)) return word.toUpperCase();
      if (/^\d/.test(word)) return word;
      return (lower.charAt(0).toUpperCase() + lower.slice(1)).replace(/-([a-z])/g, (_, letter) => '-' + letter.toUpperCase());
    }).join(' ').replace(/\bMclaren\b/g, 'McLaren').replace(/\bCitroën\b/g, 'Citroën').replace(/\bMercedes-benz\b/g, 'Mercedes-Benz').replace(/\bRolls-royce\b/g, 'Rolls-Royce');
    if (/^Evolute /i.test(name)) name = name.replace(/\bi[- ](jet|joy|pro|sky|space|van)\b/i, (_, model) => 'i-' + model.toUpperCase());
    return name;
  }
  if (typeof module === 'object' && module.exports) module.exports = { vehicleName };
  else root.vehicleName = vehicleName;
})(typeof globalThis === 'object' ? globalThis : this);
