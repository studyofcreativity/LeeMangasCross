let mangas=[];
let readerSize=localStorage.getItem('lfm_reader_size') || 'normal';
let readerWidth=localStorage.getItem('lfm_reader_width') || 'normal';
let chapterViewMode=localStorage.getItem('lfm_chapter_view_mode') || 'tomos';
let readerMode=localStorage.getItem('lfm_reader_mode') || 'normal';
let readerControlsHidden=false;
let bookState=null;
const app=document.getElementById('app');

/* ===== Cuenta anónima + likes / dislikes / comentarios / leídos ===== */
let currentUserId=null;
let readChapterIds=new Set();

async function initReaderAuth(){
  try{
    const s=await ensureAnonSession();
    currentUserId=s?.user?.id||getUserId();
    if(currentUserId) await loadReadChapters();
  }catch(e){
    console.warn('LeeMangasCross auth:',e);
  }
}

async function loadReadChapters(){
  if(!currentUserId)return;
  const {data,error}=await supabaseClient.from('chapter_reads').select('chapter_id').eq('user_id',currentUserId);
  if(error){console.warn(error);return;}
  readChapterIds=new Set((data||[]).map(r=>r.chapter_id));
}

async function markChapterRead(chapterId,mangaId){
  if(!currentUserId||!chapterId)return;
  if(readChapterIds.has(chapterId))return;
  const {error}=await supabaseClient.from('chapter_reads').upsert(
    {user_id:currentUserId,chapter_id:chapterId,manga_id:mangaId||null},
    {onConflict:'user_id,chapter_id'}
  );
  if(error){console.warn('markChapterRead',error);return;}
  readChapterIds.add(chapterId);
  // actualizar checks visibles
  document.querySelectorAll(`[data-chapter-id="${chapterId}"]`).forEach(el=>{
    el.classList.add('chapter-read');
    if(!el.querySelector('.chapter-check')){
      const s=document.createElement('span');
      s.className='chapter-check';
      s.title='Leído';
      s.textContent='✓';
      el.appendChild(s);
    }
  });
}

function chapterReadBadge(chapterId){
  if(!readChapterIds.has(chapterId)) return '';
  return '<span class="chapter-check" title="Leído">✓</span>';
}

async function loadReactionState(chapterId){
  const empty={likes:0,dislikes:0,mine:null};
  if(!chapterId)return empty;
  const {data,error}=await supabaseClient.from('chapter_reactions').select('user_id,reaction').eq('chapter_id',chapterId);
  if(error){console.warn(error);return empty;}
  let likes=0,dislikes=0,mine=null;
  for(const r of (data||[])){
    if(r.reaction==='like')likes++;
    else if(r.reaction==='dislike')dislikes++;
    if(currentUserId&&r.user_id===currentUserId)mine=r.reaction;
  }
  return {likes,dislikes,mine};
}

async function setReaction(chapterId,reaction){
  if(!currentUserId){await initReaderAuth();}
  if(!currentUserId){alert('No se pudo iniciar sesión anónima. Revisa Anonymous Sign-Ins en Supabase.');return;}
  const state=await loadReactionState(chapterId);
  if(state.mine===reaction){
    // quitar reacción
    await supabaseClient.from('chapter_reactions').delete().eq('chapter_id',chapterId).eq('user_id',currentUserId);
  }else if(state.mine){
    await supabaseClient.from('chapter_reactions').update({reaction}).eq('chapter_id',chapterId).eq('user_id',currentUserId);
  }else{
    await supabaseClient.from('chapter_reactions').insert({user_id:currentUserId,chapter_id:chapterId,reaction});
  }
  await refreshSocialBar(chapterId);
}

async function loadComments(chapterId){
  const {data,error}=await supabaseClient.from('chapter_comments')
    .select('id,user_id,body,created_at')
    .eq('chapter_id',chapterId)
    .order('created_at',{ascending:true});
  if(error){console.warn(error);return[];}
  return data||[];
}

async function postComment(chapterId){
  const input=document.getElementById('comment-input');
  const body=(input?.value||'').trim();
  if(!body)return;
  if(!currentUserId){await initReaderAuth();}
  if(!currentUserId){alert('No se pudo iniciar sesión anónima.');return;}
  if(body.length>2000){alert('Máximo 2000 caracteres.');return;}
  const {error}=await supabaseClient.from('chapter_comments').insert({
    user_id:currentUserId,chapter_id:chapterId,body
  });
  if(error){alert(error.message||'No se pudo publicar');return;}
  if(input)input.value='';
  await refreshComments(chapterId);
}

async function deleteComment(commentId,chapterId){
  if(!currentUserId)return;
  await supabaseClient.from('chapter_comments').delete().eq('id',commentId).eq('user_id',currentUserId);
  await refreshComments(chapterId);
}


function formatRelativeTime(iso){
  if(!iso)return '';
  try{
    const d=new Date(iso);
    const diff=Math.max(0, Date.now()-d.getTime());
    const sec=Math.floor(diff/1000);
    if(sec<60)return 'hace un momento';
    const min=Math.floor(sec/60);
    if(min<60)return min===1?'hace 1 minuto':`hace ${min} minutos`;
    const hr=Math.floor(min/60);
    if(hr<24)return hr===1?'hace 1 hora':`hace ${hr} horas`;
    const day=Math.floor(hr/24);
    if(day<7)return day===1?'hace 1 día':`hace ${day} días`;
    const week=Math.floor(day/7);
    if(week<5)return week===1?'hace 1 semana':`hace ${week} semanas`;
    return d.toLocaleDateString('es',{day:'numeric',month:'short',year:'numeric'});
  }catch(_){return '';}
}

function anonDisplayName(userId){
  const id=(userId||'anonimo').replace(/-/g,'').slice(0,8);
  // nombre estable a partir del id
  const names=['Lector','Fansub','Otaku','Mangaka','Shadow','Nova','Ryu','Kira','Yuki','Akira','Sora','Neko'];
  let n=0; for(let i=0;i<id.length;i++) n=(n+id.charCodeAt(i)* (i+1))%names.length;
  return names[n]+' '+id.slice(0,4).toUpperCase();
}

function anonAvatarLetter(userId){
  const name=anonDisplayName(userId);
  return (name.charAt(0)||'L').toUpperCase();
}

function formatCommentDate(iso){
  try{
    const d=new Date(iso);
    return d.toLocaleString('es',{dateStyle:'short',timeStyle:'short'});
  }catch(_){return '';}
}

async function refreshComments(chapterId){
  const box=document.getElementById('comments-list');
  if(!box)return;
  box.innerHTML='<div class="comments-loading">Cargando comentarios...</div>';
  const list=await loadComments(chapterId);
  if(!list.length){
    box.innerHTML='<div class="comments-empty">Sé el primero en comentar.</div>';
    return;
  }
  box.innerHTML=list.map(c=>{
    const mine=currentUserId&&c.user_id===currentUserId;
    const anon='Lector '+(c.user_id||'').slice(0,6);
    return `<div class="comment-item">
      <div class="comment-meta"><span>${escapeHtml(anon)}</span><span>${escapeHtml(formatCommentDate(c.created_at))}</span>
      ${mine?`<button type="button" class="comment-del" onclick="deleteComment('${c.id}','${chapterId}')">Eliminar</button>`:''}
      </div>
      <div class="comment-body">${escapeHtml(c.body)}</div>
    </div>`;
  }).join('');
}

async function refreshSocialBar(chapterId){
  const st=await loadReactionState(chapterId);
  const likeHtml=`👍 Me gusta <span id="like-count">${st.likes}</span>`;
  const dislikeHtml=`👎 No me gusta <span id="dislike-count">${st.dislikes}</span>`;
  const likeClass=`react-btn ${st.mine==='like'?'active like':''}`;
  const dislikeClass=`react-btn ${st.mine==='dislike'?'active dislike':''}`;
  const bar=document.getElementById('social-bar');
  if(bar){
    bar.innerHTML=`
      <button type="button" class="${likeClass}" onclick="setReaction('${chapterId}','like')">${likeHtml}</button>
      <button type="button" class="${dislikeClass}" onclick="setReaction('${chapterId}','dislike')">${dislikeHtml}</button>
      <button type="button" class="react-btn react-comments-jump" onclick="document.getElementById('social-panel')?.scrollIntoView({behavior:'smooth'})">💬 Comentarios</button>`;
  }
  const bar2=document.getElementById('social-bar-bottom');
  if(bar2){
    bar2.innerHTML=`
      <button type="button" class="${likeClass}" onclick="setReaction('${chapterId}','like')">👍 Me gusta <span class="like-count-bottom">${st.likes}</span></button>
      <button type="button" class="${dislikeClass}" onclick="setReaction('${chapterId}','dislike')">👎 No me gusta <span class="dislike-count-bottom">${st.dislikes}</span></button>`;
  }
}

function socialBarHtml(chapterId){
  return `<div class="social-bar social-bar-inline" id="social-bar" data-chapter-id="${chapterId}">
    <button type="button" class="react-btn" onclick="setReaction('${chapterId}','like')">👍 Me gusta <span id="like-count">…</span></button>
    <button type="button" class="react-btn" onclick="setReaction('${chapterId}','dislike')">👎 No me gusta <span id="dislike-count">…</span></button>
    <button type="button" class="react-btn react-comments-jump" onclick="document.getElementById('social-panel')?.scrollIntoView({behavior:'smooth'})">💬 Comentarios</button>
  </div>`;
}

function socialPanelHtml(chapterId){
  return `
<section class="social-panel" id="social-panel">
  <div class="social-bar" id="social-bar-bottom">
    <button type="button" class="react-btn" onclick="setReaction('${chapterId}','like')">👍 Me gusta <span class="like-count-bottom">…</span></button>
    <button type="button" class="react-btn" onclick="setReaction('${chapterId}','dislike')">👎 No me gusta <span class="dislike-count-bottom">…</span></button>
  </div>
  <div class="comments-box">
    <h3 class="comments-title">💬 Comentarios</h3>
    <div id="comments-list" class="comments-list"><div class="comments-loading">Cargando...</div></div>
    <div class="comment-form">
      <textarea id="comment-input" maxlength="2000" rows="3" placeholder="Escribe un comentario..."></textarea>
      <button type="button" class="comment-send" onclick="postComment('${chapterId}')">Publicar comentario</button>
    </div>
  </div>
</section>`;
}

async function mountSocial(chapterId){
  await refreshSocialBar(chapterId);
  await refreshComments(chapterId);
}

/* ===== Social a nivel MANGA (página de tomos) ===== */
async function loadMangaReactionState(mangaId){
  const empty={likes:0,dislikes:0,mine:null};
  if(!mangaId)return empty;
  const {data,error}=await supabaseClient.from('manga_reactions').select('user_id,reaction').eq('manga_id',mangaId);
  if(error){console.warn(error);return empty;}
  let likes=0,dislikes=0,mine=null;
  for(const r of (data||[])){
    if(r.reaction==='like')likes++;
    else if(r.reaction==='dislike')dislikes++;
    if(currentUserId&&r.user_id===currentUserId)mine=r.reaction;
  }
  return {likes,dislikes,mine};
}

async function setMangaReaction(mangaId,reaction){
  if(!currentUserId){await initReaderAuth();}
  if(!currentUserId){alert('No se pudo iniciar sesión anónima. Activa Anonymous Sign-Ins en Supabase.');return;}
  const state=await loadMangaReactionState(mangaId);
  if(state.mine===reaction){
    await supabaseClient.from('manga_reactions').delete().eq('manga_id',mangaId).eq('user_id',currentUserId);
  }else if(state.mine){
    await supabaseClient.from('manga_reactions').update({reaction}).eq('manga_id',mangaId).eq('user_id',currentUserId);
  }else{
    await supabaseClient.from('manga_reactions').insert({user_id:currentUserId,manga_id:mangaId,reaction});
  }
  await refreshMangaSocialBar(mangaId);
}

async function loadMangaComments(mangaId){
  if(!mangaId)return [];
  const {data,error}=await supabaseClient.from('manga_comments').select('*').eq('manga_id',mangaId).order('created_at',{ascending:false});
  if(error){console.warn(error);return [];}
  return data||[];
}

async function postMangaComment(mangaId){
  const input=document.getElementById('manga-comment-input');
  const body=(input?.value||'').trim();
  if(!body)return;
  if(!currentUserId){await initReaderAuth();}
  if(!currentUserId){alert('No se pudo iniciar sesión anónima.');return;}
  if(body.length>2000){alert('Máximo 2000 caracteres.');return;}
  const {error}=await supabaseClient.from('manga_comments').insert({
    user_id:currentUserId,manga_id:mangaId,body
  });
  if(error){alert(error.message||'No se pudo publicar');return;}
  if(input)input.value='';
  await refreshMangaComments(mangaId);
}

async function deleteMangaComment(commentId,mangaId){
  if(!currentUserId)return;
  await supabaseClient.from('manga_comments').delete().eq('id',commentId).eq('user_id',currentUserId);
  await refreshMangaComments(mangaId);
}

async function refreshMangaComments(mangaId){
  const box=document.getElementById('manga-comments-list');
  if(!box)return;
  box.innerHTML='<div class="comments-loading">Cargando comentarios...</div>';
  const list=await loadMangaComments(mangaId);
  if(!list.length){
    box.innerHTML='<div class="comments-empty">Sé el primero en comentar.</div>';
    return;
  }
  box.innerHTML=list.map(c=>{
    const mine=currentUserId&&c.user_id===currentUserId;
    const name=anonDisplayName(c.user_id);
    const letter=anonAvatarLetter(c.user_id);
    const when=formatRelativeTime(c.created_at);
    return `<article class="fb-comment">
      <div class="fb-avatar" aria-hidden="true">${escapeHtml(letter)}</div>
      <div class="fb-comment-main">
        <div class="fb-bubble">
          <div class="fb-name-row">
            <span class="fb-name">${escapeHtml(name)}</span>
            <span class="fb-time">${escapeHtml(when)}</span>
            ${mine?`<button type="button" class="comment-del" title="Eliminar" onclick="deleteMangaComment('${c.id}','${mangaId}')">✕</button>`:''}
          </div>
          <div class="fb-text">${escapeHtml(c.body)}</div>
        </div>
        <div class="fb-actions">
          <button type="button" class="fb-like-action" onclick="setMangaReaction('${mangaId}','like')">Me gusta</button>
        </div>
      </div>
    </article>`;
  }).join('');
}

async function refreshMangaSocialBar(mangaId){
  const st=await loadMangaReactionState(mangaId);
  const likeClass=`react-btn ${st.mine==='like'?'active like':''}`;
  const dislikeClass=`react-btn ${st.mine==='dislike'?'active dislike':''}`;
  const bar=document.getElementById('manga-social-bar');
  if(bar){
    bar.innerHTML=`
      <button type="button" class="${likeClass}" onclick="setMangaReaction('${mangaId}','like')">👍 Me gusta <span>${st.likes}</span></button>
      <button type="button" class="${dislikeClass}" onclick="setMangaReaction('${mangaId}','dislike')">👎 No me gusta <span>${st.dislikes}</span></button>`;
  }
}

function mangaSocialHtml(mangaId){
  return `
<section class="manga-social-footer" id="manga-social">
  <div class="manga-social-card">
    <div class="manga-social-card-head">
      <div class="social-bar manga-social-bar" id="manga-social-bar">
        <button type="button" class="react-btn react-like" disabled>👍 Me gusta <span>…</span></button>
        <button type="button" class="react-btn react-dislike" disabled>👎 No me gusta <span>…</span></button>
      </div>
    </div>
    <div class="fb-comments-wrap">
      <h3 class="comments-title">Comentarios</h3>
      <div id="manga-comments-list" class="fb-comments-list comments-list">
        <div class="comments-loading">Cargando...</div>
      </div>
      <div class="fb-composer comment-form">
        <div class="fb-avatar fb-avatar-me" aria-hidden="true">Tú</div>
        <div class="fb-composer-body">
          <textarea id="manga-comment-input" maxlength="2000" rows="2" placeholder="Escribe un comentario..."></textarea>
          <button type="button" class="comment-send" onclick="postMangaComment('${mangaId}')">Publicar</button>
        </div>
      </div>
    </div>
  </div>
</section>`;
}

async function mountMangaSocial(mangaId){
  await refreshMangaSocialBar(mangaId);
  await refreshMangaComments(mangaId);
}





function waitMs(ms){return new Promise(r=>setTimeout(r,ms));}

function bookReaderEl(){return document.getElementById('book-reader');}

function clearBookAnimClasses(){
  const reader=bookReaderEl();
  if(!reader)return;
  reader.classList.remove(
    'book-anim-open','book-anim-close',
    'book-anim-tomo-exit-next','book-anim-tomo-exit-prev',
    'book-anim-tomo-enter-next','book-anim-tomo-enter-prev',
    'book-anim-tomo-open'
  );
  document.querySelector('.book-stage')?.classList.remove('book-animating');
}

async function playBookAnim(className,durationMs,opts={}){
  const reader=bookReaderEl();
  if(!reader)return;
  clearBookAnimClasses();
  const stage=document.querySelector('.book-stage');
  if(stage)stage.classList.add('book-animating');
  // force reflow so animation restarts
  void reader.offsetWidth;
  reader.classList.add(className);
  await waitMs(durationMs);
  if(!opts.keepClass){
    reader.classList.remove(className);
    stage?.classList.remove('book-animating');
  }
}



function escapeHtml(s=''){const d=document.createElement('div');d.textContent=s;return d.innerHTML;}
function normalizeTag(s=''){return s.trim().replace(/\s+/g,' ');}
function mangaIsColor(m){return !!m.es_color;}
function getMangaTags(m){return Array.isArray(m.tags)?m.tags:[];}

async function loadMangas(){
 await initReaderAuth();
 app.innerHTML='<div class="loading">Cargando mangas...</div>';
 try{
   const {data,error}=await supabaseClient.from('mangas').select('*').order('nombre');
   if(error) throw error;
   const rows=data||[];
   if(!rows.length){mangas=[];renderHome(mangas);return;}
   const ids=rows.map(m=>m.id);
   const {data:links,error:linkError}=await supabaseClient
     .from('manga_etiquetas')
     .select('manga_id,etiqueta_id')
     .in('manga_id',ids);
   if(linkError) throw linkError;
   const tagIds=[...new Set((links||[]).map(x=>x.etiqueta_id).filter(Boolean))];
   let tags=[];
   if(tagIds.length){
     const {data:tagRows,error:tagError}=await supabaseClient.from('etiquetas').select('id,nombre').in('id',tagIds);
     if(tagError) throw tagError;
     tags=tagRows||[];
   }
   const tagMap=new Map(tags.map(t=>[t.id,t]));
   const byManga=new Map();
   for(const link of (links||[])){
     const tag=tagMap.get(link.etiqueta_id);
     if(tag){if(!byManga.has(link.manga_id))byManga.set(link.manga_id,[]);byManga.get(link.manga_id).push(tag);}
   }
   // Autores
   let byAutorManga=new Map();
   try{
     const {data:alinks}=await supabaseClient.from('manga_autores').select('manga_id,autor_id').in('manga_id',ids);
     const autorIds=[...new Set((alinks||[]).map(x=>x.autor_id).filter(Boolean))];
     let autores=[];
     if(autorIds.length){
       const {data:aRows}=await supabaseClient.from('autores').select('id,nombre,nombre_completo,imagen_url').in('id',autorIds);
       autores=aRows||[];
     }
     const amap=new Map(autores.map(a=>[a.id,a]));
     for(const link of (alinks||[])){
       const a=amap.get(link.autor_id);
       if(a){if(!byAutorManga.has(link.manga_id))byAutorManga.set(link.manga_id,[]);byAutorManga.get(link.manga_id).push(a);}
     }
   }catch(ae){console.warn('autores',ae)}

   mangas=rows.map(m=>({
     ...m,
     tags:(byManga.get(m.id)||[]).sort((a,b)=>a.nombre.localeCompare(b.nombre)),
     autores:(byAutorManga.get(m.id)||[]).sort((a,b)=>a.nombre.localeCompare(b.nombre))
   }));
   renderHome(mangas);
 }catch(error){
   console.error('LeeMangasCross: error cargando mangas',error);
   app.innerHTML='<div class="empty">No se pudieron cargar los mangas.<br><small>'+escapeHtml(error?.message||'Error desconocido')+'</small><br><button onclick="loadMangas()">↻ Reintentar</button></div>';
 }
}

function setChapterViewMode(mode){chapterViewMode=mode==='capitulos'?'capitulos':'tomos';localStorage.setItem('lfm_chapter_view_mode',chapterViewMode);renderHome(mangas);}
function setReaderMode(mode){readerMode=mode==='libro'?'libro':'normal';localStorage.setItem('lfm_reader_mode',readerMode);renderHome(mangas);}

function chapterModeMenu(){return `
<section class="view-mode-panel">
 <div class="view-mode-title">Organización de capítulos</div>
 <div class="view-mode-options">
  <button class="view-mode-btn ${chapterViewMode==='tomos'?'active':''}" onclick="setChapterViewMode('tomos')">📚 Ver dividido en tomos</button>
  <button class="view-mode-btn ${chapterViewMode==='capitulos'?'active':''}" onclick="setChapterViewMode('capitulos')">📖 Ver solo capítulos</button>
 </div>
 <div class="view-mode-title view-mode-subtitle">Modo de lectura</div>
 <div class="view-mode-options">
  <button class="view-mode-btn ${readerMode==='normal'?'active':''}" onclick="setReaderMode('normal')">📄 Lector normal</button>
  <button class="view-mode-btn ${readerMode==='libro'?'active':''}" onclick="setReaderMode('libro')">📕 Libro</button>
 </div>
</section>`;}

function renderTags(m){return getMangaTags(m).length?`<div class="manga-tags">${getMangaTags(m).map(t=>`<span class="tag">${escapeHtml(t.nombre)}</span>`).join('')}</div>`:''}
function getMangaAuthors(m){
  if(Array.isArray(m?.autores)&&m.autores.length)return m.autores;
  return [];
}
function renderAuthors(m){
  const list=getMangaAuthors(m);
  if(!list.length)return '';
  return `<div class="manga-authors">${list.map(a=>`
    <div class="manga-author">
      <img class="manga-author-avatar" src="${escapeHtml(a.imagen_url||'')}" alt="">
      <div class="manga-author-meta">
        <span class="manga-author-name">${escapeHtml(a.nombre||'')}</span>
        ${a.nombre_completo?`<span class="manga-author-full">${escapeHtml(a.nombre_completo)}</span>`:''}
      </div>
    </div>`).join('')}</div>`;
}
function renderHome(list){
 const filtered=list;
 app.innerHTML=`<h1>Todos los mangas</h1>${chapterModeMenu()}
 ${filtered.length?'<div class="grid">'+filtered.map(m=>`<article class="card" onclick="openManga('${m.id}')"><img src="${escapeHtml(m.portada_url||'')}" alt=""><h3>${escapeHtml(m.nombre)}</h3>${renderAuthors(m)}${renderTags(m)}</article>`).join('')+'</div>':'<div class="empty">No hay mangas en este modo todavía.</div>'}`;
}
function filterMangas(){const q=(document.getElementById('search')?.value||'').toLowerCase().trim();const list=mangas.filter(m=>m.nombre.toLowerCase().includes(q)||getMangaTags(m).some(t=>t.nombre.toLowerCase().includes(q))||getMangaAuthors(m).some(a=>(a.nombre||'').toLowerCase().includes(q)||(a.nombre_completo||'').toLowerCase().includes(q)));renderHome(list);}
async function goHome(){
  history.pushState({},'',location.pathname);
  const s=document.getElementById('search');
  if(s)s.value='';
  if(bookState&&document.body.classList.contains('book-mode')){
    await closeBookAnimated();
  }else{
    document.body.classList.remove('reader-mode','reader-controls-hidden','book-mode');
    readerControlsHidden=false;
    bookState=null;
  }
  renderHome(mangas);
}

async function closeBookAnimated(){
  if(!bookState){
    document.body.classList.remove('reader-mode','reader-controls-hidden','book-mode');
    readerControlsHidden=false;
    return;
  }
  // Ir a portada y animar cierre
  if(bookState.index!==0){
    bookState.index=0;
    bookState.animDirection='';
    renderBook();
    await waitMs(80);
  }
  await playBookAnim('book-anim-close',380);
  clearBookAnimClasses();
  document.body.classList.remove('reader-mode','reader-controls-hidden','book-mode');
  readerControlsHidden=false;
  bookState=null;
}

async function getTomoCover(t){return t?.portada_url||'';}

async function openManga(id){
 if(bookState&&document.body.classList.contains('book-mode')) await closeBookAnimated();
 else { document.body.classList.remove('reader-mode','reader-controls-hidden','book-mode');readerControlsHidden=false; bookState=null; }
 const {data:m,error:mangaError}=await supabaseClient.from('mangas').select('*').eq('id',id).single();
 if(mangaError||!m){app.innerHTML='<div class="empty">No se pudo cargar el manga.<br><small>'+escapeHtml(mangaError?.message||'Error desconocido')+'</small><br><button onclick="openManga(\''+id+'\')">↻ Reintentar</button></div>';return}
 m.tags=getMangaTags(m);
 // Autores (desde caché o consulta)
 if(!Array.isArray(m.autores)){
   try{
     const cached=mangas.find(x=>x.id===id);
     if(cached?.autores) m.autores=cached.autores;
     else {
       const {data:links}=await supabaseClient.from('manga_autores').select('autor_id').eq('manga_id',id);
       const ids=(links||[]).map(l=>l.autor_id);
       if(ids.length){
         const {data:as}=await supabaseClient.from('autores').select('id,nombre,nombre_completo,imagen_url').in('id',ids);
         m.autores=as||[];
       } else m.autores=[];
     }
   }catch(_){ m.autores=[]; }
 }
 const {data:ts}=await supabaseClient.from('tomos').select('*').eq('manga_id',id).order('numero');
 const tagHtml=renderTags(m);
 const authorHtml=renderAuthors(m);

 const headHtml=`<button class="back" onclick="goHome()">← Inicio</button>
<div class="manga-detail-head">
  <h1 class="manga-detail-title">${escapeHtml(m.nombre)}</h1>
  ${authorHtml}
  ${m.descripcion?`<p class="manga-desc">${escapeHtml(m.descripcion)}</p>`:''}
  ${tagHtml}
</div>`;

 if(chapterViewMode==='capitulos'){
  const allChapters=[];
  for(const t of (ts||[])){
    const {data:cs}=await supabaseClient.from('capitulos').select('*').eq('tomo_id',t.id).order('numero');
    (cs||[]).forEach(c=>allChapters.push({...c,tomoNumero:t.numero,tomoId:t.id,tomoCover:t.portada_url}));
  }
  app.innerHTML=`${headHtml}
<div class="chapter-view-heading">Todos los capítulos</div>
<div class="chapters chapters-all">${allChapters.map(c=>`<div class="chapter chapter-all-item ${readChapterIds.has(c.id)?'chapter-read':''}" data-chapter-id="${c.id}" onclick="openChapter('${id}','${c.tomoId}','${c.id}',${c.tomoNumero},${c.numero})"><span class="chapter-label">Capítulo ${escapeHtml(String(c.numero))}</span><small>Tomo ${escapeHtml(String(c.tomoNumero))}</small>${chapterReadBadge(c.id)}</div>`).join('')||'<div class="empty">Sin capítulos todavía.</div>'}</div>
${mangaSocialHtml(id)}`;
  mountMangaSocial(id);
  return;
 }

 app.innerHTML=`${headHtml}
<h2 class="manga-section-title">Tomos</h2>
<div class="tomos">${(ts||[]).map(t=>`<div class="tomo" onclick="openTomo('${id}','${t.id}',${t.numero})">${t.portada_url?`<img class="tomo-cover" src="${escapeHtml(t.portada_url)}" alt="">`:''}<span>Tomo ${escapeHtml(String(t.numero))}</span></div>`).join('')||'<div class="empty">Sin tomos todavía.</div>'}</div>
${mangaSocialHtml(id)}`;
  mountMangaSocial(id);
}

async function openTomo(mid,tid,num){
 if(bookState&&document.body.classList.contains('book-mode')) await closeBookAnimated();
 else { document.body.classList.remove('reader-mode','reader-controls-hidden','book-mode');readerControlsHidden=false; bookState=null; }
 const {data:cs}=await supabaseClient.from('capitulos').select('*').eq('tomo_id',tid).order('numero');
 const {data:t}=await supabaseClient.from('tomos').select('*').eq('id',tid).single();
 const bookButton=readerMode==='libro'?`<button class="book-open-btn" onclick="openBookTomo('${mid}','${tid}')">📕 Abrir tomo como libro</button>`:'';
 app.innerHTML=`<button class="back" onclick="openManga('${mid}')">← Volver al manga</button><div class="tomo-page-head">${t?.portada_url?`<img class="tomo-cover-large" src="${escapeHtml(t.portada_url)}" alt="Portada del Tomo ${escapeHtml(String(num))}">`:''}<div><h1>Tomo ${escapeHtml(String(num))}</h1>${bookButton}</div></div><div class="chapters">${(cs||[]).map(c=>`<div class="chapter ${readChapterIds.has(c.id)?'chapter-read':''}" data-chapter-id="${c.id}" onclick="openChapter('${mid}','${tid}','${c.id}',${num},${c.numero})"><span class="chapter-label">Capítulo ${escapeHtml(String(c.numero))}</span>${chapterReadBadge(c.id)}</div>`).join('')||'<div class="empty">Sin capítulos todavía.</div>'}</div>`;
}

async function getChapterNavigation(mid,tid,cid){
 const {data:manga}=await supabaseClient.from('mangas').select('id,nombre').eq('id',mid).single();
 const {data:tomos,error:tomosError}=await supabaseClient.from('tomos').select('id,numero,portada_url').eq('manga_id',mid).order('numero');
 if(tomosError||!tomos)return {mangaName:manga?.nombre||'Manga',chapters:[],index:-1,tomos:[]};
 const chapters=[];
 for(const tomo of tomos){const {data:cs}=await supabaseClient.from('capitulos').select('id,numero').eq('tomo_id',tomo.id).order('numero');(cs||[]).forEach(c=>chapters.push({id:c.id,tomoId:tomo.id,tomo:tomo.numero,cap:c.numero,tomoCover:tomo.portada_url}));}
 return {mangaName:manga?.nombre||'Manga',chapters,index:chapters.findIndex(c=>c.id===cid),tomos};
}

function progressKey(mid){return 'lfm_progress_'+mid;}
function saveProgress(mid,tid,cid,page){localStorage.setItem(progressKey(mid),JSON.stringify({tomoId:tid,chapterId:cid,page:Math.max(0,page||0)}));}
function getProgress(mid){try{return JSON.parse(localStorage.getItem(progressKey(mid))||'null')}catch(e){return null}}

async function openChapter(mid,tid,cid,tomo,cap){
 if(readerMode==='libro'){return openBookChapter(mid,tid,cid,tomo,cap);}
 const existingPage=document.querySelector('.chapter-reader-page');const wasReaderOpen=!!existingPage;const wasControlsHidden=readerControlsHidden;
 document.body.classList.add('reader-mode');if(!wasReaderOpen){readerControlsHidden=false;document.body.classList.remove('reader-controls-hidden');}
 if(existingPage){const content=existingPage.querySelector('.chapter-reader-content');if(content)content.innerHTML='<div class="loading">Cargando capítulo...</div>';}else app.innerHTML='<div class="chapter-reader-page"><div class="chapter-reader-content"><div class="loading">Cargando capítulo...</div></div></div>';
 const [pagesResult,nav]=await Promise.all([supabaseClient.from('paginas').select('*').eq('capitulo_id',cid).order('numero'),getChapterNavigation(mid,tid,cid)]);
 if(pagesResult.error){document.querySelector('.chapter-reader-content').innerHTML='<div class="empty">Error al cargar.</div>';return}
 const pages=pagesResult.data||[],index=nav.index,previous=index>0?{...nav.chapters[index-1],mangaId:mid}:null,next=index>=0&&index<nav.chapters.length-1?{...nav.chapters[index+1],mangaId:mid}:null,totalChapters=nav.chapters.length||1,target=document.querySelector('.chapter-reader-page');
 if(!target)return;
 readerControlsHidden=wasReaderOpen?wasControlsHidden:false;document.body.classList.toggle('reader-controls-hidden',readerControlsHidden);
 target.innerHTML=normalReaderHtml(mid,tid,cid,tomo,cap,pages,nav,index,previous,next,totalChapters);
 updateEyeButton();updateFullscreenButton();const isLastOfTomo=!next||next.tomoId!==tid;
const nextTomo=next&&next.tomoId!==tid?next:null;
setupChapterEndPrompt(target,mid,cid,{isLastOfTomo,tomoNum:tomo,mangaName:nav.mangaName,nextTomo});
 restoreNormalProgress(mid,tid,cid,pages.length,target);
 setupNormalProgress(target,mid,tid,cid);
 mountSocial(cid);
 if(target&&(document.fullscreenElement===target||document.webkitFullscreenElement===target))target.scrollTop=0;else window.scrollTo(0,0);
}
function normalReaderHtml(mid,tid,cid,tomo,cap,pages,nav,index,previous,next,totalChapters){return `
<aside class="reader-toolbar"><div class="toolbar-title">Lectura</div><div class="toolbar-section"><div class="toolbar-label">Tamaño</div><button class="size-btn ${readerSize==='chico'?'active':''}" onclick="setReaderSize('chico')">Chico</button><button class="size-btn ${readerSize==='normal'?'active':''}" onclick="setReaderSize('normal')">Normal</button><button class="size-btn ${readerSize==='grande'?'active':''}" onclick="setReaderSize('grande')">Grande</button><button class="size-btn ${readerSize==='muy-grande'?'active':''}" onclick="setReaderSize('muy-grande')">Muy grande</button></div><div class="toolbar-section"><div class="toolbar-label">Ancho</div><button class="width-btn ${readerWidth==='estrecho'?'active':''}" onclick="setReaderWidth('estrecho')">Estrecho</button><button class="width-btn ${readerWidth==='normal'?'active':''}" onclick="setReaderWidth('normal')">Normal</button><button class="width-btn ${readerWidth==='gordo'?'active':''}" onclick="setReaderWidth('gordo')">Gordo</button><button class="width-btn ${readerWidth==='muy-gordo'?'active':''}" onclick="setReaderWidth('muy-gordo')">Muy gordo</button></div><div class="toolbar-section toolbar-fullscreen"><button id="fullscreenBtn" class="fullscreen-btn" onclick="toggleFullscreen()">⛶ Pantalla completa</button></div><div class="toolbar-section"><button class="reader-book-switch" onclick="readerMode='libro';localStorage.setItem('lfm_reader_mode','libro');openBookChapter('${mid}','${tid}','${cid}',${tomo},${cap})">📕 Modo Libro</button></div></aside>
<div class="chapter-reader-content"><button class="back" onclick="openTomo('${mid}','${tid}',${tomo})">← Volver al tomo</button><div class="reader-header reader-meta-top"><div class="reader-meta-title-row"><div class="reader-meta-name">${escapeHtml(nav.mangaName)}</div><button id="reader-eye-toggle" class="reader-eye-toggle" type="button" onclick="toggleReaderControls()" aria-label="${readerControlsHidden?'Mostrar menú':'Ocultar menú'}" title="${readerControlsHidden?'Mostrar menú':'Ocultar menú'}">${readerControlsHidden?eyeClosedIcon():eyeOpenIcon()}</button></div><div class="reader-meta-location">Tomo ${escapeHtml(String(tomo))} · Capítulo ${escapeHtml(String(cap))}</div></div><button class="reader-side-nav reader-side-prev ${previous?'':'disabled'}" ${previous?`onclick="openChapter('${mid}','${previous.tomoId}','${previous.id}',${previous.tomo},${previous.cap})"`:'disabled'} aria-label="Capítulo anterior">‹</button><button class="reader-side-nav reader-side-next ${next?'':'disabled'}" ${next?`onclick="openChapter('${mid}','${next.tomoId}','${next.id}',${next.tomo},${next.cap})"`:'disabled'} aria-label="Capítulo siguiente">›</button>${socialBarHtml(cid)}<div class="reader-wrap"><div id="reader" class="reader size-${readerSize} width-${readerWidth}">${pages.map(p=>`<img loading="lazy" src="${escapeHtml(p.imagen_url)}" alt="Página ${escapeHtml(String(p.numero))}" data-page-number="${p.numero}">`).join('')||'<div class="empty">Este capítulo no tiene páginas.</div>'}</div></div><div class="chapter-bottom-nav"><button class="chapter-nav-btn ${previous?'':'disabled'}" ${previous?`onclick="openChapter('${mid}','${previous.tomoId}','${previous.id}',${previous.tomo},${previous.cap})"`:'disabled'}>‹</button><div class="chapter-info"><div class="chapter-manga-name">${escapeHtml(nav.mangaName)}</div><div class="chapter-location">Tomo ${escapeHtml(String(tomo))} · Capítulo ${escapeHtml(String(cap))}</div><div class="chapter-counter">Capítulo ${index>=0?index+1:escapeHtml(String(cap))} de ${totalChapters}</div></div><button class="chapter-nav-btn ${next?'':'disabled'}" ${next?`onclick="openChapter('${mid}','${next.tomoId}','${next.id}',${next.tomo},${next.cap})"`:'disabled'}>›</button></div><div id="chapter-end-prompt" class="chapter-end-prompt" aria-live="polite"><button class="chapter-end-arrow chapter-end-prev ${previous?'':'disabled'}" ${previous?`onclick="openChapter('${mid}','${previous.tomoId}','${previous.id}',${previous.tomo},${previous.cap})"`:'disabled'}>‹</button><div class="chapter-end-info"><div class="chapter-end-manga">${escapeHtml(nav.mangaName)}</div><div class="chapter-end-location">Tomo ${escapeHtml(String(tomo))} · Capítulo ${escapeHtml(String(cap))}</div></div><button class="chapter-end-arrow chapter-end-next ${next?'':'disabled'}" ${next?`onclick="openChapter('${mid}','${next.tomoId}','${next.id}',${next.tomo},${next.cap})"`:'disabled'}>›</button></div>
${socialPanelHtml(cid)}
</div>`;}



async function loadMangaCredits(mangaId){
  if(!mangaId)return [];
  try{
    const {data:rels,error}=await supabaseClient.from('manga_creditos').select('grupo_id,rol,orden').eq('manga_id',mangaId).order('orden');
    if(error)throw error;
    const ids=(rels||[]).map(r=>r.grupo_id);
    if(!ids.length)return [];
    const {data:grupos,error:ge}=await supabaseClient.from('grupos_traduccion').select('id,nombre,logo_url').in('id',ids);
    if(ge)throw ge;
    const map=new Map((grupos||[]).map(g=>[g.id,g]));
    return (rels||[]).map(r=>{
      const g=map.get(r.grupo_id);
      if(!g)return null;
      return {id:g.id,nombre:g.nombre,logo_url:g.logo_url,rol:r.rol||'',orden:r.orden};
    }).filter(Boolean);
  }catch(e){console.warn('credits',e);return [];}
}

function creditsOverlayHtml(credits,tomoNum,mangaName,opts={}){
  const list=credits&&credits.length?credits:[];
  const nextBtn=opts.nextLabel?`<button type="button" class="credits-btn primary" data-credits-next="1">${escapeHtml(opts.nextLabel)}</button>`:'';
  const backBtn=opts.backLabel?`<button type="button" class="credits-btn" data-credits-back="1">${escapeHtml(opts.backLabel)}</button>`:'';
  const empty=list.length?'':`<div class="credits-empty">No hay grupos de créditos asignados a este manga.</div>`;
  return `<div class="credits-overlay" id="credits-overlay" role="dialog" aria-modal="true" aria-label="Créditos del tomo">
    <div class="credits-card">
      <div class="credits-kicker">Fin del Tomo ${escapeHtml(String(tomoNum??''))}</div>
      <h2 class="credits-title">Créditos</h2>
      ${mangaName?`<div class="credits-manga">${escapeHtml(mangaName)}</div>`:''}
      <div class="credits-list">
        ${list.map(g=>`
          <div class="credits-item">
            ${g.logo_url?`<img class="credits-logo" src="${escapeHtml(g.logo_url)}" alt="">`:`<div class="credits-logo placeholder" aria-hidden="true"></div>`}
            <div class="credits-meta">
              <div class="credits-name">${escapeHtml(g.nombre||'')}</div>
              ${g.rol?`<div class="credits-role">${escapeHtml(g.rol)}</div>`:''}
            </div>
          </div>`).join('')}
        ${empty}
      </div>
      <div class="credits-actions">${backBtn}${nextBtn}<button type="button" class="credits-btn ghost" data-credits-close="1">Cerrar</button></div>
    </div>
  </div>`;
}

/** Muestra créditos al terminar un tomo. Siempre en body (fixed) para evitar el bug del modo normal. */
async function showTomoCredits(mangaId,tomoNum,opts={}){
  // Evitar duplicados
  document.getElementById('credits-overlay')?.remove();
  const credits=await loadMangaCredits(mangaId);
  if(!credits.length){
    if(typeof opts.onEmpty==='function') opts.onEmpty();
    return false;
  }
  const wrap=document.createElement('div');
  wrap.innerHTML=creditsOverlayHtml(credits,tomoNum,opts.mangaName||'',{
    nextLabel:opts.nextLabel||'',
    backLabel:opts.backLabel||''
  });
  const overlay=wrap.firstElementChild;
  // Siempre fixed sobre toda la ventana (no dentro del reader)
  document.body.appendChild(overlay);
  // Forzar paint
  overlay.offsetHeight;
  overlay.classList.add('visible');

  const close=()=>{
    overlay.classList.remove('visible');
    setTimeout(()=>overlay.remove(),180);
    if(typeof opts.onClose==='function') opts.onClose();
  };
  overlay.querySelector('[data-credits-close]')?.addEventListener('click',(e)=>{e.stopPropagation();close();});
  overlay.querySelector('[data-credits-back]')?.addEventListener('click',(e)=>{
    e.stopPropagation();
    overlay.classList.remove('visible');
    setTimeout(()=>overlay.remove(),180);
    if(typeof opts.onBack==='function') opts.onBack();
  });
  overlay.querySelector('[data-credits-next]')?.addEventListener('click',(e)=>{
    e.stopPropagation();
    overlay.classList.remove('visible');
    setTimeout(()=>{
      overlay.remove();
      if(typeof opts.onNext==='function') opts.onNext();
    },120);
  });
  overlay.addEventListener('click',(e)=>{if(e.target===overlay)close();});
  return true;
}

/**
 * Modo normal: al llegar al final del último capítulo del tomo muestra créditos una vez.
 * La flecha › del final del tomo también abre créditos en vez de saltar directo.
 */
function setupChapterEndPrompt(target,mangaId,chapterId,ctx={}){
  if(!target)return;
  if(target._endPromptCleanup)target._endPromptCleanup();
  const prompt=target.querySelector('#chapter-end-prompt');
  if(!prompt)return;
  const isLastOfTomo=!!ctx.isLastOfTomo;
  const tomoNum=ctx.tomoNum;
  const mangaName=ctx.mangaName||'';
  let creditsShown=false;
  let creditsBusy=false;

  const isFullscreen=()=>document.fullscreenElement===target||document.webkitFullscreenElement===target;
  const getScrollMetrics=()=>isFullscreen()
    ?{top:target.scrollTop,height:target.scrollHeight,view:target.clientHeight}
    :{top:window.scrollY,height:document.documentElement.scrollHeight,view:window.innerHeight};

  const openCredits=async(fromNav)=>{
    if(creditsBusy)return;
    if(creditsShown&&document.getElementById('credits-overlay'))return;
    creditsBusy=true;
    try{
      const nextTomo=ctx.nextTomo;
      const shown=await showTomoCredits(mangaId,tomoNum,{
        mangaName,
        nextLabel: nextTomo ? 'Siguiente tomo' : 'Volver al manga',
        backLabel: 'Seguir leyendo',
        onNext: ()=>{
          if(nextTomo){
            openChapter(mangaId,nextTomo.tomoId,nextTomo.id,nextTomo.tomo,nextTomo.cap);
          }else{
            openManga(mangaId);
          }
        }
      });
      // Marcar siempre tras el intento para no spamear el overlay
      creditsShown=true;
    }finally{
      creditsBusy=false;
    }
  };

  const check=()=>{
    const m=getScrollMetrics();
    const nearBottom=(m.top+m.view)>=(m.height-140);
    if(nearBottom&&chapterId) markChapterRead(chapterId,mangaId);
    const showEndPrompt=nearBottom&&readerControlsHidden;
    prompt.classList.toggle('show',showEndPrompt);
    target.classList.toggle('chapter-at-end',showEndPrompt);
    target.querySelectorAll('.reader-side-nav').forEach(el=>{
      if(showEndPrompt) el.style.display='none';
      else el.style.removeProperty('display');
    });
    // Auto-mostrar créditos solo una vez al llegar al fondo del último cap del tomo
    if(nearBottom&&isLastOfTomo&&!creditsShown&&!creditsBusy&&mangaId){
      openCredits(false);
    }
  };

  // Interceptar flechas › cuando es fin de tomo → créditos primero
  if(isLastOfTomo){
    const intercept=(ev)=>{
      const btn=ev.target.closest('.chapter-end-arrow.chapter-end-next, .chapter-nav-btn, .reader-side-nav.reader-side-next');
      if(!btn)return;
      // solo botones de avanzar
      if(btn.classList.contains('chapter-end-prev')||btn.classList.contains('reader-side-prev'))return;
      if(btn.classList.contains('disabled')||btn.hasAttribute('disabled'))return;
      // Si el botón es el de "siguiente" del final de este capítulo/tomo
      const isNext=
        btn.classList.contains('chapter-end-next')||
        btn.classList.contains('reader-side-next')||
        (btn.classList.contains('chapter-nav-btn')&&btn.textContent.includes('›'));
      if(!isNext)return;
      ev.preventDefault();
      ev.stopPropagation();
      openCredits(true);
    };
    // capture phase para ganar al onclick inline
    target.addEventListener('click',intercept,true);
    target._creditsIntercept=intercept;
  }

  const onWindowScroll=()=>check();
  const onTargetScroll=()=>check();
  window.addEventListener('scroll',onWindowScroll,{passive:true});
  target.addEventListener('scroll',onTargetScroll,{passive:true});
  window.addEventListener('resize',check);
  target._checkChapterEnd=check;
  target._endPromptCleanup=()=>{
    window.removeEventListener('scroll',onWindowScroll);
    target.removeEventListener('scroll',onTargetScroll);
    window.removeEventListener('resize',check);
    if(target._creditsIntercept) target.removeEventListener('click',target._creditsIntercept,true);
    // no dejar overlay huérfano al cambiar de capítulo
    document.getElementById('credits-overlay')?.remove();
  };
  check();
}

function eyeOpenIcon(){return '<svg class="eye-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>'}
function eyeClosedIcon(){return '<svg class="eye-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M4.5 9.5C6.3 7.4 8.8 6 12 6c6.5 0 10 6 10 6-.9 1.5-2.1 2.8-3.5 3.8M4.5 9.5C3 10.7 2 12 2 12s3.5 6 10 6c1.3 0 2.5-.2 3.6-.7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'}
function updateEyeButton(){const btn=document.getElementById('reader-eye-toggle');if(!btn)return;btn.innerHTML=readerControlsHidden?eyeClosedIcon():eyeOpenIcon();btn.setAttribute('aria-label',readerControlsHidden?'Mostrar menú':'Ocultar menú');btn.setAttribute('title',readerControlsHidden?'Mostrar menú':'Ocultar menú');btn.classList.toggle('closed',readerControlsHidden);}
function toggleReaderControls(){if(!document.body.classList.contains('reader-mode'))return;readerControlsHidden=!readerControlsHidden;document.body.classList.toggle('reader-controls-hidden',readerControlsHidden);updateEyeButton();const target=document.querySelector('.chapter-reader-page');if(target&&typeof target._checkChapterEnd==='function')target._checkChapterEnd();}
async function toggleFullscreen(){const target=document.querySelector('.chapter-reader-page');if(!target)return;try{if(!document.fullscreenElement&&!document.webkitFullscreenElement){if(target.requestFullscreen)await target.requestFullscreen();else if(target.webkitRequestFullscreen)target.webkitRequestFullscreen();}else{if(document.exitFullscreen)await document.exitFullscreen();else if(document.webkitExitFullscreen)document.webkitExitFullscreen();}}catch(e){console.error(e)}}
function updateFullscreenButton(){const btn=document.getElementById('fullscreenBtn');if(btn)btn.textContent=(document.fullscreenElement||document.webkitFullscreenElement)?'⛶ Salir de pantalla completa':'⛶ Pantalla completa';}
document.addEventListener('fullscreenchange',updateFullscreenButton);document.addEventListener('webkitfullscreenchange',updateFullscreenButton);
function updateReaderClass(){const r=document.getElementById('reader');if(r)r.className='reader size-'+readerSize+' width-'+readerWidth;}
function setReaderSize(s){readerSize=s;localStorage.setItem('lfm_reader_size',s);updateReaderClass();document.querySelectorAll('.size-btn').forEach(b=>b.classList.remove('active'));const map={chico:0,normal:1,grande:2,'muy-grande':3},buttons=[...document.querySelectorAll('.size-btn')];if(buttons[map[s]])buttons[map[s]].classList.add('active');}
function setReaderWidth(w){readerWidth=w;localStorage.setItem('lfm_reader_width',w);updateReaderClass();document.querySelectorAll('.width-btn').forEach(b=>b.classList.remove('active'));const map={estrecho:0,normal:1,gordo:2,'muy-gordo':3},buttons=[...document.querySelectorAll('.width-btn')];if(buttons[map[w]])buttons[map[w]].classList.add('active');}

// ---------------- MODO LIBRO ----------------
// El Libro mantiene un único índice sobre las páginas reales del tomo.
// La precarga solo crea Image() en memoria y nunca añade páginas al DOM.
async function fetchTomoBook(mid,tid){
  const {data:t,error:te}=await supabaseClient
    .from('tomos').select('*').eq('id',tid).single();
  if(te||!t) throw te||new Error('Tomo no encontrado');

  const {data:cs,error:ce}=await supabaseClient
    .from('capitulos').select('id,numero').eq('tomo_id',tid).order('numero');
  if(ce) throw ce;

  const chapters=[];
  for(const c of (cs||[])){
    const {data:ps,error:pe}=await supabaseClient
      .from('paginas')
      .select('id,numero,imagen_url')
      .eq('capitulo_id',c.id)
      .order('numero',{ascending:true});
    if(pe) throw pe;

    // El orden es exclusivamente el número guardado en public.paginas.
    // No se usa el orden accidental de Storage.
    const pages=(ps||[])
      .slice()
      .sort((a,b)=>Number(a.numero)-Number(b.numero))
      .map((p,i)=>({
        id:p.id,
        numero:p.numero,
        src:p.imagen_url,
        page:i+1
      }));

    chapters.push({id:c.id,numero:c.numero,pages});
  }
  return {tomo:t,chapters};
}

function flattenBook(book){
  const items=[{type:'cover',src:book.tomo.portada_url||'',tomo:book.tomo.numero}];
  for(const c of book.chapters){
    for(const p of c.pages){
      items.push({
        type:'page',
        src:p.src,
        id:p.id,
        chapterId:c.id,
        chapter:c.numero,
        page:p.page,
        numero:p.numero
      });
    }
  }
  return items;
}

function getBookItem(state,index){
  return state?.items?.[index]||null;
}

function bookIsDesktopSpread(state){
  const item=getBookItem(state,state.index);
  return !!(window.innerWidth>=900 && item && item.type==='page');
}

function chapterFirstIndex(items,chapterId){
  return items.findIndex(x=>x.type==='page'&&x.chapterId===chapterId);
}

function bookProgressPosition(book,mid,tid){
  const p=getProgress(mid);
  if(!p||p.tomoId!==tid) return 0;

  let index=1;
  for(const c of book.chapters){
    if(c.id===p.chapterId){
      const page=Math.max(1,Math.min(Number(p.page)||1,c.pages.length||1));
      return index+page-1;
    }
    index+=c.pages.length;
  }
  return 0;
}

async function openBookTomo(mid,tid,options={}){
  try{
    const direction=options.direction||null; // 'next' | 'prev' | null
    const animateOpen=options.animateOpen!==false;
    const isSwitch=!!(bookState&&bookState.mid===mid&&bookState.tid!==tid&&direction);

    if(isSwitch){
      await switchTomoAnimated(mid,tid,direction);
      return;
    }

    const book=await fetchTomoBook(mid,tid);
    const saved=getProgress(mid);
    // En apertura fresca desde el menú de tomo, empezar en portada (índice 0)
    // salvo que se pida restaurar progreso explícitamente.
    const start=options.restoreProgress && saved && saved.tomoId===tid
      ? bookProgressPosition(book,mid,tid)
      : (saved&&saved.tomoId===tid&&!animateOpen ? bookProgressPosition(book,mid,tid) : 0);
    await openBookUI(mid,tid,book,start,{fromTomo:true,animateOpen,direction:null});
  }catch(e){
    console.error(e);
    app.innerHTML='<div class="empty">No se pudo cargar el libro.</div>';
  }
}

async function switchTomoAnimated(mid,tid,direction){
  const s=bookState;
  if(!s)return;

  // 1) Cerrar hacia la portada si no estamos en ella
  if(s.index!==0){
    s.index=0;
    s.animDirection='';
    renderBook();
    await playBookAnim('book-anim-close',380);
  }

  // 2) Portada actual sale de la pantalla (mantener estado final hasta montar el nuevo)
  const exitClass=direction==='prev'?'book-anim-tomo-exit-prev':'book-anim-tomo-exit-next';
  await playBookAnim(exitClass,400,{keepClass:true});

  // 3) Cargar tomo nuevo
  let book;
  try{
    book=await fetchTomoBook(mid,tid);
  }catch(e){
    console.error(e);
    app.innerHTML='<div class="empty">No se pudo cargar el libro.</div>';
    return;
  }

  // 4) Montar estado en portada del tomo nuevo
  const {data:m}=await supabaseClient.from('mangas').select('id,nombre').eq('id',mid).single();
  const {data:tomos}=await supabaseClient.from('tomos').select('id,numero,portada_url').eq('manga_id',mid).order('numero');
  const items=flattenBook(book);
  const oldHidden=s.controlsHidden||false;

  bookState={
    mid,tid,book,items,
    index:0,
    controlsHidden:oldHidden,
    mangaName:m?.nombre||'Manga',
    navTomos:tomos||[],
    chapterFlash:false,
    animDirection:'',
    pageFocus:'right',
    touchX:null,
    imageCache:new Map(),
    viewZoom:1,
    viewPanX:0,
    viewPanY:0
  };

  document.body.classList.add('reader-mode','book-mode');
  document.body.classList.toggle('book-controls-hidden',oldHidden);

  let page=document.querySelector('.book-reader-page');
  if(!page){
    app.innerHTML='<div class="chapter-reader-page book-reader-page"><div id="book-reader"></div></div>';
    page=document.querySelector('.book-reader-page');
  }else if(!document.getElementById('book-reader')){
    page.innerHTML='<div id="book-reader"></div>';
  }

  // 5) Nueva portada entra
  clearBookAnimClasses();
  renderBook();
  const enterClass=direction==='prev'?'book-anim-tomo-enter-prev':'book-anim-tomo-enter-next';
  await playBookAnim(enterClass,400);

  // 6) Se abre solo y pasa a la página 1 (no se queda en la portada)
  await playBookAnim('book-anim-tomo-open',320);
  if(bookState && bookState.items.length>1){
    // Página 1 del primer capítulo (índice 1 tras la portada) = derecha del primer spread
    bookState.index=1;
    bookState.animDirection='next';
    renderBook();
    await playBookAnim('book-anim-tomo-open',280);
  }

  preloadBookNeighbors();
  window.setTimeout(()=>{ if(bookState) preloadBookNeighbors(); }, 100);
}

async function openBookChapter(mid,tid,cid,tomo,cap){
  try{
    const book=await fetchTomoBook(mid,tid);
    const items=flattenBook(book);
    const start=chapterFirstIndex(items,cid);
    await openBookUI(mid,tid,book,start>0?start:0,{fromTomo:false,animateOpen:true});
  }catch(e){
    console.error(e);
    app.innerHTML='<div class="empty">No se pudo cargar el libro.</div>';
  }
}

function bookIndexToChapter(book,index){
  if(index<=0) return null;
  // Preferir items ya aplanados en bookState para no recalcular flattenBook
  const item=(bookState&&bookState.book===book?bookState.items:null)?.[index]
    || (book?flattenBook(book)[index]:null);
  if(!item||item.type!=='page') return null;
  return {
    chapter:{id:item.chapterId,numero:item.chapter},
    page:item.page,
    numero:item.numero,
    chapterId:item.chapterId
  };
}

function bookCanGoPrev(state){return !!state && (state.index>0 || state.navTomos.findIndex(t=>t.id===state.tid)>0);}
function bookCanGoNext(state){return !!state && (state.index<state.items.length-1 || state.navTomos.findIndex(t=>t.id===state.tid)<state.navTomos.length-1);}

function renderBookPage(item,state,side){
  if(!item){
    return '<div class="book-sheet book-blank" aria-hidden="true"></div>';
  }
  // draggable=false + oncontextmenu evitan menú de imagen / long-press en móvil
  const imgAttrs='decoding="async" loading="eager" fetchpriority="high" draggable="false" oncontextmenu="return false"';
  if(item.type==='cover'){
    if(!item.src) return '<div class="book-sheet book-cover-sheet" aria-label="Portada sin imagen"></div>';
    return `<div class="book-sheet book-cover-sheet" data-side="${side||''}"><img ${imgAttrs} src="${escapeHtml(item.src)}" alt="Portada del tomo"></div>`;
  }
  return `<div class="book-sheet book-page-sheet" data-side="${side||''}" data-page="${escapeHtml(String(item.page))}"><img ${imgAttrs} src="${escapeHtml(item.src)}" alt="Página ${escapeHtml(String(item.page))}" data-book-page-id="${escapeHtml(item.id||'')}"></div>`;
}

function bookSpreadForState(state){
  const item=getBookItem(state,state.index);
  if(!item) return {desktop:false,left:null,right:null,single:true};
  if(item.type==='cover') return {desktop:false,left:null,right:item,single:true};

  // Doble página desde 700px (antes 900 dejaba muchas pantallas en modo 1 página)
  const wide=window.innerWidth>=700;
  if(!wide) return {desktop:false,left:null,right:item,single:true};

  // Inicio del bloque de páginas de este capítulo en la lista plana
  let chapterStart=state.index;
  while(chapterStart>0){
    const p=getBookItem(state,chapterStart-1);
    if(!p||p.type!=='page'||p.chapterId!==item.chapterId) break;
    chapterStart--;
  }
  // Fin del capítulo
  let chapterEnd=state.index;
  while(true){
    const n=getBookItem(state,chapterEnd+1);
    if(!n||n.type!=='page'||n.chapterId!==item.chapterId) break;
    chapterEnd++;
  }

  const local=state.index-chapterStart; // 0-based
  // Par: (0,1), (2,3), ... → derecha=par local, izquierda=impar local
  const rightLocal=local%2===0 ? local : local-1;
  const leftLocal=rightLocal+1;
  const rightIndex=chapterStart+rightLocal;
  const leftIndex=chapterStart+leftLocal;

  const right=getBookItem(state,rightIndex);
  const left=leftLocal+chapterStart<=chapterEnd ? getBookItem(state,leftIndex) : null;

  const rightOk=!!(right&&right.type==='page'&&right.chapterId===item.chapterId);
  const leftOk=!!(left&&left.type==='page'&&left.chapterId===item.chapterId);

  if(rightOk&&leftOk){
    return {desktop:true,left,right,single:false,rightIndex,leftIndex};
  }
  const only=rightOk?right:item;
  return {desktop:false,left:null,right:only,single:true,rightIndex:rightOk?rightIndex:state.index,leftIndex:null};
}


/* ===== Zoom + cámara del modo libro (pantalla completa / lectura) ===== */
const BOOK_ZOOM_MIN=1;
const BOOK_ZOOM_MAX=2.5;
const BOOK_ZOOM_STEP=0.28; // 28% por paso

/** Página activa actual (sheet + img) */
function getActiveBookSheet(){
  const stage=document.querySelector('.book-stage');
  if(!stage || !bookState) return {stage:null,sheet:null,img:null};
  let sheet=null;
  if(window.innerWidth>=700){
    const focus=(bookState.pageFocus==='left')?'left':'right';
    sheet=stage.querySelector(`.book-sheet[data-side="${focus}"]`)
      || stage.querySelector('.book-sheet:not(.book-blank)');
  }else{
    sheet=stage.querySelector('.book-sheet:not(.book-blank)');
  }
  return {stage, sheet, img: sheet?.querySelector('img')||null};
}

/**
 * Límites de pan generosos según el tamaño REAL de la imagen (sin transform)
 * y del contenedor. Permite recorrer toda el área ampliada.
 */
function getBookPanLimits(s, sheet, img){
  const z=Math.max(BOOK_ZOOM_MIN, Math.min(BOOK_ZOOM_MAX, s.viewZoom||1));
  if(z<=1.02) return {maxX:0, maxY:0, z};

  // offsetWidth/Height NO se ven afectados por CSS transform → medición estable
  let iw=0, ih=0, sw=0, sh=0;
  if(img){
    iw=img.offsetWidth || img.clientWidth || 0;
    ih=img.offsetHeight || img.clientHeight || 0;
  }
  if(sheet){
    sw=sheet.clientWidth || sheet.offsetWidth || 0;
    sh=sheet.clientHeight || sheet.offsetHeight || 0;
  }
  if(!sw || !sh){
    sw=window.innerWidth*0.85;
    sh=window.innerHeight*0.8;
  }
  if(!iw) iw=sw;
  if(!ih) ih=sh;

  // Tamaño visual tras el scale
  const visW=iw*z, visH=ih*z;
  // Pan máximo = lo que sobresale a cada lado (recorrer toda el área ampliada)
  let maxX=Math.max(0, (visW - sw) / 2);
  let maxY=Math.max(0, (visH - sh) / 2);

  // Asegurar recorrido generoso aunque haya letterboxing
  maxX=Math.max(maxX, (sw * (z - 1)) / 2);
  maxY=Math.max(maxY, (sh * (z - 1)) / 2);

  return {maxX, maxY, z};
}

function clampBookPan(s, sheet, img){
  if(!s)return;
  const ref=(!sheet || !img) ? getActiveBookSheet() : {sheet, img};
  const {maxX, maxY, z}=getBookPanLimits(s, ref.sheet, ref.img);
  s.viewZoom=z;
  if(z<=1.02){ s.viewPanX=0; s.viewPanY=0; return; }
  s.viewPanX = Math.max(-maxX, Math.min(maxX, s.viewPanX||0));
  s.viewPanY = Math.max(-maxY, Math.min(maxY, s.viewPanY||0));
}

/**
 * Aplica zoom+pan a la imagen activa.
 * @param {{animate?:boolean, skipClamp?:boolean, instant?:boolean}} opts
 */
function applyBookViewTransform(opts={}){
  const s=bookState;
  if(!s)return;
  // No interferir mientras el usuario arrastra
  if(s._isPanning && !opts.force) return;

  const {stage, sheet, img}=getActiveBookSheet();
  if(!stage)return;

  stage.querySelectorAll('.book-sheet img').forEach(el=>{
    if(el!==img){
      el.style.transform='';
      el.style.transition='';
    }
  });
  stage.querySelectorAll('.book-sheet').forEach(sh=>{
    sh.classList.remove('book-sheet-zoomed');
  });

  const z=Math.max(BOOK_ZOOM_MIN, Math.min(BOOK_ZOOM_MAX, s.viewZoom||1));
  s.viewZoom=z;
  if(!opts.skipClamp) clampBookPan(s, sheet, img);

  if(!sheet || !img)return;

  sheet.classList.add('book-sheet-zoomed');
  sheet.style.overflow='hidden';

  const animate = !opts.instant && opts.animate !== false && !s._isPanning;
  const transition = animate
    ? 'transform .25s cubic-bezier(.22,.72,.26,1)'
    : 'none';

  if(z<=1.01){
    s.viewPanX=0; s.viewPanY=0;
    img.style.transition=transition;
    img.style.transform='none';
    return;
  }

  img.style.transformOrigin='center center';
  img.style.transition=transition;
  img.style.transform=`translate(${s.viewPanX||0}px, ${s.viewPanY||0}px) scale(${z})`;
}

function bookZoomIn(){
  const s=bookState; if(!s)return;
  s.viewZoom=Math.min(BOOK_ZOOM_MAX, (s.viewZoom||1)+BOOK_ZOOM_STEP);
  clampBookPan(s);
  applyBookViewTransform({animate:true, force:true});
  updateBookZoomButtons();
}
function bookZoomOut(){
  const s=bookState; if(!s)return;
  s.viewZoom=Math.max(BOOK_ZOOM_MIN, (s.viewZoom||1)-BOOK_ZOOM_STEP);
  clampBookPan(s);
  applyBookViewTransform({animate:true, force:true});
  updateBookZoomButtons();
}
function updateBookZoomButtons(){
  const s=bookState;
  const zin=document.getElementById('book-zoom-in');
  const zout=document.getElementById('book-zoom-out');
  if(!zin||!zout||!s)return;
  const z=s.viewZoom||1;
  zout.disabled = z <= BOOK_ZOOM_MIN + 0.01;
  zin.disabled  = z >= BOOK_ZOOM_MAX - 0.01;
  zout.classList.toggle('disabled', zout.disabled);
  zin.classList.toggle('disabled', zin.disabled);
  const label=document.getElementById('book-zoom-label');
  if(label) label.textContent = Math.round(z*100)+'%';
}

/** Aplica foco de página (par) + zoom/cámara. */
function applyBookPageFocus(){
  const s=bookState;
  if(!s)return;
  const stage=document.querySelector('.book-stage');
  const spread=document.querySelector('.book-spread.book-spread-pair');
  if(!stage)return;

  if(window.innerWidth<700){
    if(spread){
      spread.querySelectorAll('.book-sheet').forEach(el=>{ el.style.cssText=''; });
    }
    applyBookViewTransform();
    updateBookZoomButtons();
    return;
  }
  if(!spread){
    applyBookViewTransform();
    updateBookZoomButtons();
    return;
  }
  const left=spread.querySelector('.book-sheet[data-side="left"]');
  const right=spread.querySelector('.book-sheet[data-side="right"]');
  if(!left||!right){
    applyBookViewTransform();
    updateBookZoomButtons();
    return;
  }
  const focus=(s.pageFocus==='left')?'left':'right';
  const active=focus==='left'?left:right;
  const other=focus==='left'?right:left;

  // Menú oculto → ratios un poco más moderados para no cortar contenido
  const menuHidden = !!(s.controlsHidden);
  const activeW = menuHidden ? '74%' : '78%';
  const otherW  = menuHidden ? '26%' : '22%';
  const otherOp = menuHidden ? '0.38' : '0.32';
  const otherBr = menuHidden ? 'brightness(0.5)' : 'brightness(0.45)';

  active.style.setProperty('flex','3 1 0%','important');
  active.style.setProperty('width',activeW,'important');
  active.style.setProperty('max-width',activeW,'important');
  active.style.setProperty('min-width','0','important');
  active.style.setProperty('opacity','1','important');
  active.style.setProperty('filter','none','important');
  active.style.setProperty('z-index','3','important');
  active.style.setProperty('transition','flex .3s ease,width .3s ease,max-width .3s ease,opacity .25s ease,filter .25s ease','important');

  other.style.setProperty('flex','1 1 0%','important');
  other.style.setProperty('width',otherW,'important');
  other.style.setProperty('max-width',otherW,'important');
  other.style.setProperty('min-width','0','important');
  other.style.setProperty('opacity',otherOp,'important');
  other.style.setProperty('filter',otherBr,'important');
  other.style.setProperty('z-index','1','important');
  other.style.setProperty('transition','flex .3s ease,width .3s ease,max-width .3s ease,opacity .25s ease,filter .25s ease','important');

  spread.style.setProperty('display','flex','important');
  spread.style.setProperty('flex-direction','row','important');
  spread.style.setProperty('align-items','stretch','important');
  spread.style.setProperty('width','100%','important');
  spread.style.setProperty('max-width','100%','important');
  spread.style.setProperty('transform','none','important');

  applyBookViewTransform();
  updateBookZoomButtons();
}

function renderBook(){
  const s=bookState;if(!s) return;

  // En escritorio, el cursor del spread debe quedar en la página DERECHA del par
  // (índice local par dentro del capítulo: 0,2,4...), para mostrar siempre 1+2, 3+4, etc.
  const current=getBookItem(s,s.index);
  if(window.innerWidth>=700 && current?.type==='page'){
    let chapterStart=s.index;
    while(chapterStart>0){
      const prev=getBookItem(s,chapterStart-1);
      if(!prev||prev.type!=='page'||prev.chapterId!==current.chapterId) break;
      chapterStart--;
    }
    const local=s.index-chapterStart;
    if(local%2===1){
      // Estamos en la página izquierda del par → retroceder a la derecha
      s.index=s.index-1;
    }
  }

  const spread=bookSpreadForState(s);
  const currentRight=spread.right;
  // Asegurar pageFocus válido
  if(!spread.desktop || spread.single || !spread.left) s.pageFocus='right';
  if(s.pageFocus!=='left' && s.pageFocus!=='right') s.pageFocus='right';
  const focusedItem=(spread.desktop && !spread.single && s.pageFocus==='left' && spread.left)
    ? spread.left
    : (currentRight||spread.right);
  const chapterMeta=focusedItem?.type==='page'
    ? `Tomo ${s.book.tomo.numero} · Capítulo ${focusedItem.chapter} · Página ${focusedItem.page}${spread.desktop&&spread.left?` (${spread.right.page}-${spread.left.page})`:''}`
    : (currentRight?.type==='cover' || s.index===0 ? `Portada` : `Portada`);
  const tomoMeta=`Tomo ${s.book.tomo.numero}`;
  const chapterId=currentRight?.type==='page'?currentRight.chapterId:null;

  const nextVisible=bookCanGoNext(s);
  const prevVisible=bookCanGoPrev(s);
  const reader=document.getElementById('book-reader');
  if(!reader) return;

  const nextClass=s.animDirection==='next'?'book-flip-next':s.animDirection==='prev'?'book-flip-prev':'';

  reader.innerHTML=`
    <div class="book-topbar">
      <button class="book-eye" onclick="toggleBookControls()">${s.controlsHidden?eyeClosedIcon():eyeOpenIcon()}</button>
      <div class="book-title">${escapeHtml(s.mangaName)}<small>${escapeHtml(chapterMeta)}</small></div>
      <button class="book-full" onclick="toggleBookFullscreen()">⛶</button>
    </div>
    <div class="book-stage ${spread.desktop?'book-two-pages':''}${spread.single?' book-stage-single':''} ${spread.desktop&&!spread.single?('book-focus-'+s.pageFocus):''}">
      <button class="book-arrow book-arrow-left" onclick="bookArrowLeft()" aria-label="Avanzar">‹</button>
      <div class="book-spread ${spread.desktop?'book-spread-pair':''} ${nextClass}">
        ${spread.desktop && spread.left ? renderBookPage(spread.left,s,'left') : ''}
        ${renderBookPage(spread.right,s,'right')}
      </div>
      <button class="book-arrow book-arrow-right" onclick="bookArrowRight()" aria-label="Retroceder">›</button>
      <div class="book-zoom-controls" id="book-zoom-controls" aria-label="Zoom de página">
        <button type="button" id="book-zoom-out" class="book-zoom-btn" onclick="bookZoomOut()" title="Alejar" aria-label="Alejar">−</button>
        <span id="book-zoom-label" class="book-zoom-label">100%</span>
        <button type="button" id="book-zoom-in" class="book-zoom-btn" onclick="bookZoomIn()" title="Acercar" aria-label="Acercar">+</button>
      </div>
    </div>
    <div class="book-bottom"><span>${escapeHtml(tomoMeta)}</span><span>${s.index===0?'Portada':escapeHtml(chapterMeta)}</span></div>
    ${s.chapterFlash?`<div class="book-chapter-flash">Capítulo ${escapeHtml(String(currentRight?.chapter??''))}</div>`:''}`;

  reader.classList.toggle('book-controls-hidden',s.controlsHidden);
  document.body.classList.toggle('book-controls-hidden',s.controlsHidden);

  const direction=s.animDirection;
  s.animDirection='';
  preloadBookNeighbors();
  applyBookPageFocus();
  setupBookPanHandlers();
  const spreadEl=reader.querySelector('.book-spread');
  if(direction && spreadEl){
    window.setTimeout(()=>{
      if(spreadEl.isConnected){
        spreadEl.classList.remove('book-flip-next','book-flip-prev');
      }
      if(bookState===s){
        applyBookPageFocus();
        preloadBookNeighbors();
      }
    }, 560);
  }
}

function setBookIndex(index,direction){
  const s=bookState;if(!s)return false;
  const prevIndex=s.index;
  const next=Math.max(0,Math.min(index,s.items.length-1));
  if(next===s.index)return false;
  const prevItem=getBookItem(s,prevIndex);
  s.index=next;
  s.animDirection=direction;
  // Al cambiar de página/spread: recentrar cámara (mantener nivel de zoom)
  s.viewPanX=0;
  s.viewPanY=0;
  // Al cambiar de spread: avanzar → derecha; retroceder → izquierda (si hay par)
  if(direction==='next') s.pageFocus='right';
  else if(direction==='prev') s.pageFocus=s.pageFocus||'left';

  const currCh=bookIndexToChapter(s.book,s.index)?.chapterId||null;
  const prevCh=bookIndexToChapter(s.book,prevIndex)?.chapterId||null;
  s.chapterFlash=!!(currCh&&prevCh&&currCh!==prevCh);
  saveBookProgress();
  renderBook();
  preloadBookNeighbors();
  // Capítulo terminado al pasar al siguiente o al quedar en la última página del capítulo
  if(direction==='next'&&prevCh&&currCh&&prevCh!==currCh){
    markChapterRead(prevCh,s.mid);
  }
  const curItem=getBookItem(s,s.index);
  if(curItem?.type==='page'){
    const after=getBookItem(s,s.index+1);
    const after2=getBookItem(s,s.index+2);
    const noMoreInChapter=!(after?.type==='page'&&after.chapterId===curItem.chapterId)
      && !(after2?.type==='page'&&after2.chapterId===curItem.chapterId);
    // también si el spread actual incluye la última página (izquierda)
    const left=getBookItem(s,s.index+1);
    if(left?.type==='page'&&left.chapterId===curItem.chapterId){
      const afterLeft=getBookItem(s,s.index+2);
      if(!(afterLeft?.type==='page'&&afterLeft.chapterId===curItem.chapterId)){
        markChapterRead(curItem.chapterId,s.mid);
      }
    }else if(noMoreInChapter){
      markChapterRead(curItem.chapterId,s.mid);
    }
  }
  if(s.chapterFlash){
    window.setTimeout(()=>{if(bookState===s){s.chapterFlash=false;renderBook();}},700);
  }
  return true;
}


/**
 * Flechas con doble función en modo libro (escritorio, doble página):
 * - pageFocus 'right' = leyendo la página derecha del spread
 * - pageFocus 'left'  = leyendo la página izquierda
 *
 * Flecha IZQUIERDA (avance manga RTL):
 *   derecha → enfoca izquierda
 *   izquierda → siguiente par de páginas (o fin / siguiente tomo)
 *
 * Flecha DERECHA (retroceso):
 *   izquierda → enfoca derecha
 *   derecha → par anterior (o portada)
 */
function bookHasPairSpread(){
  const s=bookState;if(!s)return false;
  if(window.innerWidth<700)return false;
  const spread=bookSpreadForState(s);
  return !!(spread.desktop && !spread.single && spread.left && spread.right);
}

async function bookArrowLeft(){
  const s=bookState;if(!s)return;
  if(s.index===0){
    // Portada → abrir / avanzar
    await bookNext();
    return;
  }
  if(bookHasPairSpread()){
    if((s.pageFocus||'right')==='right'){
      s.pageFocus='left';
      s.viewPanX=0; s.viewPanY=0;
      s.animDirection='';
      renderBook();
      return;
    }
    // En izquierda: siguiente spread, empezar en derecha
    s.pageFocus='right';
    await bookNext();
    return;
  }
  await bookNext();
}

async function bookArrowRight(){
  const s=bookState;if(!s)return;
  if(s.index===0){
    // Portada: flecha derecha = tomo anterior / menú
    await bookPrev();
    return;
  }
  if(bookHasPairSpread()){
    if((s.pageFocus||'right')==='left'){
      s.pageFocus='right';
      s.viewPanX=0; s.viewPanY=0;
      s.animDirection='';
      renderBook();
      return;
    }
    // En derecha: spread anterior, quedar en la izquierda de ese par
    s.pageFocus='left';
    await bookPrev();
    // Si al volver no hay par, no forzar left
    if(bookState===s && !bookHasPairSpread()){
      s.pageFocus='right';
      renderBook();
    }
    return;
  }
  await bookPrev();
}

async function bookNext(){
  const s=bookState;if(!s)return;
  if(s.index===0){
    if(s.items.length>1){
      setBookIndex(1,'next');
    }else{
      const i=s.navTomos.findIndex(t=>t.id===s.tid);
      if(i>=0&&i<s.navTomos.length-1){
        await openBookTomo(s.mid,s.navTomos[i+1].id,{direction:'next',animateOpen:false});
      }else{
        const mid=s.mid;
        await closeBookAnimated();
        await openManga(mid);
      }
    }
    return;
  }

  const item=getBookItem(s,s.index);
  if(!item)return;

  if(window.innerWidth>=700){
    // Avanzar un spread completo (2 páginas del mismo capítulo si existen)
    const nxt=getBookItem(s,s.index+1);
    const nxt2=getBookItem(s,s.index+2);
    // Si hay pareja (derecha actual + izquierda siguiente), saltar a la siguiente derecha
    if(nxt?.type==='page' && nxt.chapterId===item.chapterId){
      if(nxt2?.type==='page' && nxt2.chapterId===item.chapterId){
        setBookIndex(s.index+2,'next');
        return;
      }
      // Solo había una página más en el capítulo (la izquierda): ir a siguiente capítulo
      const nextChapterIndex=s.items.findIndex((x,i)=>i>s.index && x.type==='page' && x.chapterId!==item.chapterId);
      if(nextChapterIndex>0){
        setBookIndex(nextChapterIndex,'next');
        return;
      }
    }else{
      // Página suelta al final del capítulo → siguiente capítulo
      const nextChapterIndex=s.items.findIndex((x,i)=>i>s.index && x.type==='page' && x.chapterId!==item.chapterId);
      if(nextChapterIndex>0){
        setBookIndex(nextChapterIndex,'next');
        return;
      }
    }
  }else{
    if(s.index<s.items.length-1){
      setBookIndex(s.index+1,'next');
      return;
    }
  }

  // Fin del tomo en modo libro → créditos (si hay) y luego siguiente tomo o menú
  const i=s.navTomos.findIndex(t=>t.id===s.tid);
  const hasNextTomo=i>=0&&i<s.navTomos.length-1;
  const tomoNum=s.book?.tomo?.numero ?? '';
  const mid=s.mid;
  const nextTid=hasNextTomo?s.navTomos[i+1].id:null;
  const shown=await showTomoCredits(mid,tomoNum,{
    mangaName:s.mangaName||'',
    nextLabel: hasNextTomo ? 'Siguiente tomo' : 'Volver al manga',
    backLabel: 'Quedarme aquí',
    onNext: async ()=>{
      if(hasNextTomo){
        await openBookTomo(mid,nextTid,{direction:'next',animateOpen:false});
      }else{
        await closeBookAnimated();
        await openManga(mid);
      }
    },
    onEmpty: async ()=>{
      if(hasNextTomo){
        await openBookTomo(mid,nextTid,{direction:'next',animateOpen:false});
      }else{
        await closeBookAnimated();
        await openManga(mid);
      }
    }
  });
  if(!shown){
    // showTomoCredits ya llamó onEmpty si no había créditos
  }
}

async function bookPrev(){
  const s=bookState;if(!s)return;
  if(s.index===0){
    const i=s.navTomos.findIndex(t=>t.id===s.tid);
    if(i>0){
      await openBookTomo(s.mid,s.navTomos[i-1].id,{direction:'prev',animateOpen:false});
    }else{
      // Primer tomo en portada: volver al menú del manga
      const mid=s.mid;
      await closeBookAnimated();
      await openManga(mid);
    }
    return;
  }

  const item=getBookItem(s,s.index);
  if(!item)return;

  if(window.innerWidth>=700){
    // Retroceder un spread: a la pareja anterior del mismo capítulo, o capítulo previo
    if(s.index<=1){
      // Portada o primera página
      setBookIndex(0,'prev');
      return;
    }
    const prev=getBookItem(s,s.index-1);
    const prev2=getBookItem(s,s.index-2);
    if(prev?.type==='page' && prev.chapterId===item.chapterId){
      // Hay página izquierda del spread actual → la derecha del spread anterior es index-2
      if(prev2?.type==='page' && prev2.chapterId===item.chapterId){
        setBookIndex(s.index-2,'prev');
        return;
      }
      setBookIndex(Math.max(1,s.index-1),'prev');
      return;
    }
    // Cambio de capítulo: ir a la última "derecha" del capítulo anterior
    let i=s.index-1;
    while(i>0){
      const x=getBookItem(s,i);
      if(x?.type==='page' && x.chapterId!==item.chapterId){
        // Alinear a índice local par dentro de ese capítulo
        let cs=i;
        while(cs>0){
          const p=getBookItem(s,cs-1);
          if(!p||p.type!=='page'||p.chapterId!==x.chapterId) break;
          cs--;
        }
        const local=i-cs;
        if(local%2===1) i=i-1;
        setBookIndex(Math.max(1,i),'prev');
        return;
      }
      i--;
    }
    setBookIndex(0,'prev');
    return;
  }

  setBookIndex(s.index-1,'prev');
}

function saveBookProgress(){
  const s=bookState;if(!s)return;
  const cp=bookIndexToChapter(s.book,s.index);
  if(cp) saveProgress(s.mid,s.tid,cp.chapter.id,cp.page);
}

function preloadBookNeighbors(){
  const s=bookState;if(!s)return;
  if(!s.imageCache)s.imageCache=new Map();

  // Prioridad: las 4 siguientes, luego 2 anteriores, luego un poco más adelante.
  // Así al avanzar siempre hay margen de páginas ya en caché del navegador.
  const ordered=[];
  for(let d=1;d<=4;d++) ordered.push(s.index+d);
  for(let d=1;d<=2;d++) ordered.push(s.index-d);
  for(let d=5;d<=8;d++) ordered.push(s.index+d);

  const seen=new Set();
  for(const i of ordered){
    if(i<0||i>=s.items.length||seen.has(i))continue;
    seen.add(i);
    const x=s.items[i];
    if(!x||x.type!=='page'||!x.src)continue;
    if(s.imageCache.has(x.src))continue;
    const im=new Image();
    im.decoding='async';
    // fetchpriority alto solo para las 2 primeras siguientes
    if(i===s.index+1||i===s.index+2){
      try{im.fetchPriority='high';}catch(_){}
    }
    im.src=x.src;
    s.imageCache.set(x.src,im);
  }

  // Limitar tamaño de caché en memoria (mantener ~30 URLs recientes)
  if(s.imageCache.size>40){
    const keys=[...s.imageCache.keys()];
    for(let k=0;k<keys.length-30;k++) s.imageCache.delete(keys[k]);
  }
}

async function openNextTomoFromBook(){
  const s=bookState;if(!s)return;
  const ti=s.navTomos.findIndex(t=>t.id===s.tid);
  if(ti>=0&&ti<s.navTomos.length-1){
    await openBookTomo(s.mid,s.navTomos[ti+1].id,{direction:'next',animateOpen:false});
  }else{
    const mid=s.mid;
    await closeBookAnimated();
    await openManga(mid);
  }
}
async function openPrevTomoFromBook(){
  const s=bookState;if(!s)return;
  const ti=s.navTomos.findIndex(t=>t.id===s.tid);
  if(ti>0){
    await openBookTomo(s.mid,s.navTomos[ti-1].id,{direction:'prev',animateOpen:false});
  }else{
    const mid=s.mid;
    await closeBookAnimated();
    await openManga(mid);
  }
}

async function openBookUI(mid,tid,book,start,opts={}){
  // Compat: openBookUI(..., true) o openBookUI(..., {fromTomo,animateOpen})
  if(typeof opts==='boolean') opts={fromTomo:opts};
  const fromTomo=!!opts.fromTomo;
  const animateOpen=opts.animateOpen!==false;

  const oldPage=document.querySelector('.book-reader-page');
  const wasFullscreen=!!(oldPage&&(document.fullscreenElement===oldPage||document.webkitFullscreenElement===oldPage));
  const oldHidden=bookState?.controlsHidden||false;
  const wasAlreadyBook=!!bookState && document.body.classList.contains('book-mode');

  const {data:m}=await supabaseClient.from('mangas').select('id,nombre').eq('id',mid).single();
  const {data:tomos}=await supabaseClient.from('tomos').select('id,numero,portada_url').eq('manga_id',mid).order('numero');
  const items=flattenBook(book);
  bookState={
    mid,tid,book,items,
    index:Math.max(0,Math.min(Number(start)||0,Math.max(items.length-1,0))),
    controlsHidden:oldHidden,
    mangaName:m?.nombre||'Manga',
    navTomos:tomos||[],
    chapterFlash:false,
    animDirection:'',
    pageFocus:'right',
    touchX:null,
    imageCache:bookState?.imageCache instanceof Map ? bookState.imageCache : new Map(),
    viewZoom: bookState?.viewZoom > 1 ? Math.min(bookState.viewZoom, 1.4) : 1,
    viewPanX:0,
    viewPanY:0
  };

  // En escritorio, alinear al índice local par (página derecha del spread).
  const initial=getBookItem(bookState,bookState.index);
  if(window.innerWidth>=700 && initial?.type==='page'){
    let cs=bookState.index;
    while(cs>0){
      const p=getBookItem(bookState,cs-1);
      if(!p||p.type!=='page'||p.chapterId!==initial.chapterId) break;
      cs--;
    }
    if((bookState.index-cs)%2===1) bookState.index--;
  }

  document.body.classList.add('reader-mode','book-mode');
  document.body.classList.toggle('book-controls-hidden',oldHidden);
  if(oldPage){
    if(!document.getElementById('book-reader')) oldPage.innerHTML='<div id="book-reader"></div>';
  }else{
    app.innerHTML='<div class="chapter-reader-page book-reader-page"><div id="book-reader"></div></div>';
  }

  renderBook();
  preloadBookNeighbors();
  window.setTimeout(()=>{ if(bookState) preloadBookNeighbors(); }, 120);

  // Animación de apertura del libro (solo si no venimos de un cambio de tomo animado)
  if(animateOpen && !wasAlreadyBook){
    await playBookAnim('book-anim-open',480);
  }

  const page=document.querySelector('.book-reader-page');
  if(wasFullscreen&&page&&!document.fullscreenElement){
    try{
      if(page.requestFullscreen) await page.requestFullscreen();
      else if(page.webkitRequestFullscreen) page.webkitRequestFullscreen();
    }catch(e){console.warn(e)}
  }
  try{
    if(document.fullscreenElement&&screen.orientation?.lock) await screen.orientation.lock('landscape');
  }catch(e){}
}

function toggleBookControls(){
  if(!bookState)return;
  const willHide=!bookState.controlsHidden;
  bookState.controlsHidden=willHide;
  // Al ocultar el menú las páginas ocupan más espacio: bajar un poco el zoom para no cortar contenido
  if(willHide && (bookState.viewZoom||1) > 1.05){
    bookState.viewZoom=Math.max(BOOK_ZOOM_MIN, (bookState.viewZoom||1) - 0.22);
    bookState.viewPanX=0;
    bookState.viewPanY=0;
  }
  renderBook();
}
async function toggleBookFullscreen(){const p=document.querySelector('.book-reader-page');if(!p)return;try{if(!document.fullscreenElement){if(p.requestFullscreen)await p.requestFullscreen();else if(p.webkitRequestFullscreen)p.webkitRequestFullscreen();}else if(document.exitFullscreen)await document.exitFullscreen();}catch(e){console.error(e)}}

/** Arrastre suave de la cámara cuando hay zoom (siempre dentro de la página). */
function setupBookPanHandlers(){
  const stage=document.querySelector('.book-stage');
  if(!stage || stage._bookPanBound) return;
  stage._bookPanBound=true;

  let dragging=false, lastX=0, lastY=0, activeSheet=null, activeImg=null, pointerId=null;

  stage.addEventListener('contextmenu',e=>{
    e.preventDefault();
    e.stopPropagation();
    return false;
  },{capture:true});

  const onDown=(clientX,clientY,target,pid)=>{
    const s=bookState;
    if(!s || (s.viewZoom||1) <= 1.05) return false;
    if(target?.closest?.('.book-arrow, .book-zoom-controls, .book-topbar, .book-eye, .book-full')) return false;
    if(dragging) return false; // evitar doble inicio touch+pointer
    const ref=getActiveBookSheet();
    activeSheet=ref.sheet;
    activeImg=ref.img;
    if(!activeImg) return false;
    dragging=true;
    s._isPanning=true;
    pointerId=pid??null;
    lastX=clientX; lastY=clientY;
    stage.classList.add('book-panning');
    document.body.classList.add('book-panning');
    activeImg.style.transition='none';
    return true;
  };
  const onMove=(clientX,clientY)=>{
    if(!dragging || !bookState || !activeImg) return;
    const s=bookState;
    const dx=clientX-lastX, dy=clientY-lastY;
    lastX=clientX; lastY=clientY;
    s.viewPanX=(s.viewPanX||0)+dx;
    s.viewPanY=(s.viewPanY||0)+dy;
    clampBookPan(s, activeSheet, activeImg);
    activeImg.style.transition='none';
    activeImg.style.transform=`translate(${s.viewPanX}px, ${s.viewPanY}px) scale(${s.viewZoom||1})`;
  };
  const onUp=()=>{
    if(!dragging) return;
    dragging=false;
    pointerId=null;
    stage.classList.remove('book-panning');
    document.body.classList.remove('book-panning');
    // Quedarse exactamente donde el usuario soltó (sin animación ni recentrado)
    if(bookState){
      bookState._isPanning=false;
      if(activeImg){
        clampBookPan(bookState, activeSheet, activeImg);
        activeImg.style.transition='none';
        activeImg.style.transform=`translate(${bookState.viewPanX||0}px, ${bookState.viewPanY||0}px) scale(${bookState.viewZoom||1})`;
      }
    }
    activeSheet=null;
    activeImg=null;
  };

  // Un solo camino con Pointer Events (funciona en PC y móvil moderno)
  stage.addEventListener('pointerdown',e=>{
    if(e.button!==0 && e.pointerType!=='touch' && e.pointerType!=='pen') return;
    if(onDown(e.clientX,e.clientY,e.target,e.pointerId)){
      try{ stage.setPointerCapture(e.pointerId); }catch(_){}
      e.preventDefault();
      e.stopPropagation();
    }
  },{passive:false});
  stage.addEventListener('pointermove',e=>{
    if(!dragging) return;
    if(pointerId!=null && e.pointerId!==pointerId) return;
    onMove(e.clientX,e.clientY);
    e.preventDefault();
  },{passive:false});
  stage.addEventListener('pointerup',e=>{
    if(pointerId!=null && e.pointerId!==pointerId) return;
    onUp();
  });
  stage.addEventListener('pointercancel',e=>{
    if(pointerId!=null && e.pointerId!==pointerId) return;
    onUp();
  });
  // NO usar lostpointercapture → evita recentrado accidental en móvil

  // touchstart solo para cancelar long-press (no inicia pan; lo hace pointer)
  stage.addEventListener('touchstart',e=>{
    if(!bookState || (bookState.viewZoom||1) <= 1.05) return;
    if(e.target?.closest?.('.book-arrow, .book-zoom-controls, .book-topbar, .book-eye, .book-full')) return;
    if(e.touches.length===1){
      e.preventDefault(); // bloquea callout / menú de imagen
    }
  },{passive:false,capture:true});

  stage.addEventListener('wheel',e=>{
    if(!bookState) return;
    e.preventDefault();
    if(e.deltaY < 0) bookZoomIn();
    else bookZoomOut();
  },{passive:false});
}

document.addEventListener('keydown',e=>{
  if(!bookState)return;
  if(['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName))return;
  if(e.key==='ArrowLeft'){e.preventDefault();bookArrowLeft();}
  else if(e.key==='ArrowRight'){e.preventDefault();bookArrowRight();}
  else if(e.key==='+' || e.key==='='){e.preventDefault();bookZoomIn();}
  else if(e.key==='-' || e.key==='_'){e.preventDefault();bookZoomOut();}
  else if(e.key==='Escape'&&document.fullscreenElement)document.exitFullscreen?.();
});

document.addEventListener('touchstart',e=>{
  if(!bookState||e.touches.length!==1)return;
  // Si hay zoom, el pan lo gestiona pointer; no interferir con swipe de página
  if((bookState.viewZoom||1)>1.05) return;
  bookState.touchX=e.touches[0].clientX;
},{passive:true});
document.addEventListener('touchend',e=>{
  if(!bookState||bookState.touchX==null)return;
  if((bookState.viewZoom||1)>1.05){ bookState.touchX=null; return; }
  const dx=e.changedTouches[0].clientX-bookState.touchX;
  bookState.touchX=null;
  if(Math.abs(dx)>55){ if(dx<0) bookArrowLeft(); else bookArrowRight(); }
},{passive:true});


function setupNormalProgress(target,mid,tid,cid){
  if(!target)return;
  if(target._progressCleanup)target._progressCleanup();
  let lastSaved=0;
  const isFs=()=>document.fullscreenElement===target||document.webkitFullscreenElement===target;
  const saveCurrent=()=>{
    const imgs=[...target.querySelectorAll('#reader img[data-page-number]')];
    if(!imgs.length)return;
    const viewH=isFs()?target.clientHeight:window.innerHeight;
    let best=null,bestScore=-Infinity;
    for(const img of imgs){
      const r=img.getBoundingClientRect();
      // Prefer the page whose top is near the upper third of the viewport
      if(r.bottom<=40||r.top>=viewH-20)continue;
      const score=-(Math.abs(r.top-viewH*0.12))+Math.min(r.height,viewH)*0.001;
      if(score>bestScore){bestScore=score;best=img;}
    }
    if(!best){
      for(const img of imgs){
        const r=img.getBoundingClientRect();
        if(r.bottom>60&&r.top<viewH-60){best=img;break;}
      }
    }
    if(best){
      const page=Number(best.getAttribute('data-page-number'))||1;
      if(page!==lastSaved){
        lastSaved=page;
        saveProgress(mid,tid,cid,page);
      }
    }
  };
  let ticking=false;
  const onScroll=()=>{
    if(ticking)return;
    ticking=true;
    requestAnimationFrame(()=>{saveCurrent();ticking=false;});
  };
  const onWindowScroll=()=>{if(!isFs())onScroll();};
  const onTargetScroll=()=>{if(isFs())onScroll();};
  window.addEventListener('scroll',onWindowScroll,{passive:true});
  target.addEventListener('scroll',onTargetScroll,{passive:true});
  target._progressCleanup=()=>{
    window.removeEventListener('scroll',onWindowScroll);
    target.removeEventListener('scroll',onTargetScroll);
  };
  setTimeout(saveCurrent,120);
}

function restoreNormalProgress(mid,tid,cid,pagesLength,target){const p=getProgress(mid);if(!p||p.tomoId!==tid||p.chapterId!==cid)return;const page=Math.max(1,Math.min(p.page||1,pagesLength||1));setTimeout(()=>{const img=target.querySelector(`img[data-page-number="${page}"]`);if(img)img.scrollIntoView({block:'start'});},80);}


window.addEventListener('error', e => {
  console.error('LeeMangasCross:', e.error || e.message);
});
window.addEventListener('unhandledrejection', e => {
  console.error('LeeMangasCross:', e.reason);
});

(async function boot(){
  try{
    await initReaderAuth();
  }catch(e){
    console.warn('LeeMangasCross: auth anónima no disponible aún', e);
  }
  loadMangas();
})();
