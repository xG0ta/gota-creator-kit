(function () {
  var cep = window.__adobe_cep__;
  var cepFs = window.cep && window.cep.fs;
  var roots = [];
  var currentFolder = null;
  var selectedFile = null;
  var fs = window.require && window.require('fs');
  var path = window.require && window.require('path');
  var os = window.require && window.require('os');
  var key = 'gotaCreatorKit.legacy.roots';
  var $ = function (id) { return document.getElementById(id); };

  function setStatus(message, isError) {
    var node = $('status'); node.textContent = message; node.className = isError ? 'status error' : 'status';
  }
  function evalHost(script, callback) {
    if (!cep || !cep.evalScript) { callback(''); return; }
    cep.evalScript(script, callback);
  }
  function escapeJs(value) { return JSON.stringify(String(value)); }
  function saveRoots() { localStorage.setItem(key, JSON.stringify(roots)); }
  function loadRoots() { try { roots = JSON.parse(localStorage.getItem(key) || '[]'); } catch (_) { roots = []; } }
  function list(folder) {
    if (!fs || !path) return [];
    try { return fs.readdirSync(folder, { withFileTypes: true }).map(function (entry) { return { name: entry.name, path: path.join(folder, entry.name), directory: entry.isDirectory() }; }).sort(function(a,b){ return Number(b.directory)-Number(a.directory) || a.name.localeCompare(b.name); }); } catch (_) { return []; }
  }
  function renderRoots() {
    var box = $('roots'); box.innerHTML = '';
    if (!roots.length) { box.className = 'roots empty'; box.textContent = 'Añade una o más carpetas raíz.'; return; }
    box.className = 'roots'; roots.forEach(function (root) { var b = document.createElement('button'); b.className = 'root'; b.textContent = '▸  ' + (path ? path.basename(root) : root); b.title = root; b.onclick = function(){ currentFolder = root; renderFiles(); }; box.appendChild(b); });
  }
  function renderFiles() {
    var box = $('files'); box.innerHTML = ''; selectedFile = null; $('place').disabled = true; $('preview').innerHTML = ''; $('preview').className = 'preview empty';
    if (!currentFolder) { box.className='file-list empty'; box.textContent='Elige una carpeta.'; return; }
    var query = $('search').value.trim().toLowerCase(); var entries = list(currentFolder).filter(function(e){return !query || e.name.toLowerCase().indexOf(query)!==-1;});
    if (!entries.length) { box.className='file-list empty'; box.textContent='No hay elementos visibles.'; return; }
    box.className='file-list'; entries.forEach(function (entry) { var b=document.createElement('button'); b.className='file'; b.textContent=(entry.directory?'📁 ':'▧ ')+entry.name; b.title=entry.path; b.onclick=function(){ if(entry.directory){ currentFolder=entry.path; renderFiles(); } else { selectFile(entry,b); } }; box.appendChild(b); });
  }
  function selectFile(file, button) {
    selectedFile=file.path; Array.prototype.forEach.call($('files').children,function(item){item.classList.remove('selected')}); button.classList.add('selected'); $('place').disabled=false;
    var preview=$('preview'); preview.innerHTML=''; preview.className='preview'; var ext=(path.extname(file.name)||'').toLowerCase();
    var url='file://'+file.path.replace(/\\/g,'/').replace(/ /g,'%20'); var media;
    if (/\.(mp4|mov|m4v|webm)$/i.test(ext)) { media=document.createElement('video'); media.controls=true; media.src=url; }
    else if (/\.(mp3|wav|m4a|aif|aiff)$/i.test(ext)) { media=document.createElement('audio'); media.controls=true; media.src=url; }
    else if (/\.(png|jpg|jpeg|gif|webp)$/i.test(ext)) { media=document.createElement('img'); media.src=url; }
    else { preview.className='preview empty'; preview.textContent='No hay vista previa para este formato.'; }
    if(media){ preview.appendChild(media); }
  }
  function chooseFolder() {
    if (!cepFs || !cepFs.showOpenDialogEx) { setStatus('Este panel necesita el motor CEP de Premiere.',true); return; }
    var result=cepFs.showOpenDialogEx(false,true,'Elige una carpeta para Biblioteca Gota','','',[]);
    if(result && result.err===0 && result.data && result.data.length){ if(roots.indexOf(result.data[0])===-1) roots.push(result.data[0]); saveRoots(); renderRoots(); if(!currentFolder){currentFolder=result.data[0];renderFiles();} }
  }
  function checkHost() {
    evalHost('$._GotaLegacy.hostInfo()',function(result){ try { var info=JSON.parse(result); $('host-version').textContent='Premiere '+info.version; setStatus(info.sequence ? 'Secuencia activa: '+info.sequence : 'Abre una secuencia para colocar recursos.'); } catch (_) { $('host-version').textContent='Premiere 2024'; } });
  }
  $('add-root').onclick=chooseFolder; $('search').oninput=renderFiles;
  $('place').onclick=function(){ if(!selectedFile)return; setStatus('Añadiendo recurso…'); evalHost('$._GotaLegacy.importAtPlayhead('+escapeJs(selectedFile)+')',function(result){ try { var data=JSON.parse(result); setStatus(data.ok ? data.message : data.message,true); } catch (_) { setStatus('Premiere no confirmó la colocación.',true); } }); };
  $('check-engine').onclick=function(){ fetch('http://127.0.0.1:8765/health').then(function(r){return r.json()}).then(function(){ $('engine-status').textContent='Motor local conectado y listo.'; }).catch(function(){ $('engine-status').textContent='El motor local no responde. Ejecuta el instalador completo de Gota Creator Kit.'; }); };
  loadRoots(); renderRoots(); if(roots.length){currentFolder=roots[0];renderFiles();} checkHost();
}());
