// static/js/app.js
// PDF Manager
// Código defensivo e compatível com endpoint /api/upload, /api/delete, /api/delete-all e /api/rotate

(function () {
  'use strict';

  const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content || '';
  const THUMB_WIDTH = 160;
  const THUMB_HEIGHT = 208;

  // elementos do viewer
  const canvas = document.getElementById('pdf-canvas');
  const ctx = canvas ? canvas.getContext('2d') : null;
  const placeholder = document.getElementById('canvas-placeholder');
  const feedbackEl = document.getElementById('rotate-feedback');

  // estado
  let filesOrder = Array.from(document.querySelectorAll('.thumb-card')).map(c => c.dataset.fname || '');
  let currentFile = null;
  let pdfDoc = null;
  let currentPage = 1;
  let totalPages = 0;
  let scale = 1.0;

  // ---------- Helpers ----------
  function apiJson(url, method = 'GET', data = null) {
    const opts = { method, headers: {} };
    if (method !== 'GET') {
      // JSON requests
      if (!(data instanceof FormData)) {
        opts.headers['Content-Type'] = 'application/json';
        if (csrfToken) opts.headers['X-CSRFToken'] = csrfToken;
      } else {
        // FormData - let browser set Content-Type
        if (csrfToken) opts.headers['X-CSRFToken'] = csrfToken;
      }
    }
    if (data && !(data instanceof FormData)) opts.body = JSON.stringify(data);
    else if (data instanceof FormData) opts.body = data;
    return fetch(url, opts).then(async r => {
      const text = await r.text();
      try { return JSON.parse(text); } catch (e) { return { status: r.status, text }; }
    });
  }

  function urlFor(file, bust = true) {
    let u = `/view/${encodeURIComponent(file)}`;
    if (bust) u += `?t=${Date.now()}`;
    return u;
  }

  // ---------- Thumbnails ----------
  async function renderThumbnail(cardEl, file) {
    const canvasEl = cardEl.querySelector('.thumb-canvas');
    if (!canvasEl) return;
    const cctx = canvasEl.getContext('2d');
    cctx.clearRect(0, 0, canvasEl.width || THUMB_WIDTH, canvasEl.height || THUMB_HEIGHT);
    try {
      const loadingTask = pdfjsLib.getDocument(urlFor(file));
      const doc = await loadingTask.promise;
      const page = await doc.getPage(1);
      const viewport = page.getViewport({ scale: 1 });
      const scaleThumb = Math.min(THUMB_WIDTH / viewport.width, THUMB_HEIGHT / viewport.height);
      const vp = page.getViewport({ scale: scaleThumb });
      canvasEl.width = Math.round(vp.width);
      canvasEl.height = Math.round(vp.height);
      await page.render({ canvasContext: cctx, viewport: vp }).promise;
      try { await doc.destroy(); } catch (_) {}
    } catch (err) {
      cctx.fillStyle = '#f3f3f3';
      cctx.fillRect(0, 0, canvasEl.width || THUMB_WIDTH, canvasEl.height || THUMB_HEIGHT);
      cctx.fillStyle = '#666';
      cctx.font = '12px sans-serif';
      cctx.fillText('Erro preview', 6, 20);
      console.debug('renderThumbnail error', file, err);
    }
  }

  function renderAllThumbnails() {
    const cards = Array.from(document.querySelectorAll('.thumb-card'));
    cards.forEach((card, i) => setTimeout(() => renderThumbnail(card, card.dataset.fname), i * 12));
  }

  // ---------- Viewer ----------
  async function loadPdf(file, page = 1) {
    markActiveFile(file);
    currentFile = file;
    const currentFilenameEl = document.getElementById('current-filename');
    if (currentFilenameEl) currentFilenameEl.textContent = file;
    if (placeholder) placeholder.style.display = 'none';

    try {
      if (pdfDoc) { try { await pdfDoc.destroy(); } catch (_) {} pdfDoc = null; }
      const loadingTask = pdfjsLib.getDocument(urlFor(file));
      pdfDoc = await loadingTask.promise;
      totalPages = pdfDoc.numPages || 0;
      currentPage = Math.min(Math.max(1, page), Math.max(1, totalPages));
      const pageInfoEl = document.getElementById('page-info');
      if (pageInfoEl) pageInfoEl.textContent = `${currentPage} / ${totalPages}`;
      await renderPage(currentPage);
      scrollActiveIntoView();
    } catch (err) {
      console.error('loadPdf error', err);
      if (placeholder) { placeholder.style.display = 'flex'; placeholder.textContent = 'Falha ao carregar PDF.'; }
      if (canvas) { canvas.width = 0; canvas.height = 0; }
      pdfDoc = null; totalPages = 0;
      const pi = document.getElementById('page-info'); if (pi) pi.textContent = `0 / 0`;
    }
  }

  async function renderPage(num) {
    if (!pdfDoc || !ctx) return;
    currentPage = num;
    const page = await pdfDoc.getPage(num);
    const vp = page.getViewport({ scale: scale });
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const pageInfoEl = document.getElementById('page-info');
    if (pageInfoEl) pageInfoEl.textContent = `${currentPage} / ${totalPages}`;
    const zoomEl = document.getElementById('zoom-level');
    if (zoomEl) zoomEl.textContent = `${Math.round(scale * 100)}%`;
  }

  // ---------- Sidebar helpers ----------
  function markActiveFile(file) {
    document.querySelectorAll('.thumb-card').forEach(c => c.classList.remove('active'));
    if (!file) return;
    const el = document.querySelector(`.thumb-card[data-fname="${CSS.escape(file)}"]`);
    if (el) el.classList.add('active');
  }
  function scrollActiveIntoView() {
    const el = document.querySelector('.thumb-card.active');
    if (!el) return;
    try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_) { el.scrollIntoView(); }
  }

  // ---------- Feedback ----------
  function showRotateFeedback() {
    if (!feedbackEl) return;
    feedbackEl.classList.remove('visible');
    void feedbackEl.offsetWidth;
    feedbackEl.classList.add('visible');
    setTimeout(() => feedbackEl.classList.remove('visible'), 1100);
  }

  // ---------- Upload modal (gerenciador) ----------
  (function setupUploadModal() {
    const modal = document.getElementById('upload-modal');
    const inputHidden = document.getElementById('upload-input-hidden');
    const btnAddMore = document.getElementById('upload-add-more');
    const btnClear = document.getElementById('upload-clear');
    const btnCancel = document.getElementById('upload-cancel');
    const btnStart = document.getElementById('upload-start');
    const listEl = document.getElementById('upload-list');
    const emptyEl = document.getElementById('upload-empty');
    const countEl = document.getElementById('upload-count');
    const progressWrap = document.getElementById('upload-progress');
    const progressText = document.getElementById('upload-progress-text');

    if (!modal || !inputHidden || !btnAddMore || !btnStart || !listEl) return;

    // estado local: Map<nome, File>
    const filesMap = new Map();

    function modalOpen() {
      modal.classList.add('open');
      modal.setAttribute('aria-hidden', 'false');
      inputHidden.value = "";
      renderList();
    }
    function modalClose() {
      modal.classList.remove('open');
      modal.removeAttribute('aria-hidden');
    }

    function renderList() {
      while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
      if (filesMap.size === 0) {
        listEl.appendChild(emptyEl);
        countEl.textContent = "0";
        return;
      }
      countEl.textContent = String(filesMap.size);
      for (const [name, file] of filesMap.entries()) {
        const row = document.createElement('div');
        row.className = 'upload-item';
        row.style = "display:flex;align-items:center;gap:8px;padding:6px;border-radius:6px;border-bottom:1px solid #f2f5fb";

        const info = document.createElement('div');
        info.style = "flex:1;min-width:0";
        const title = document.createElement('div');
        title.textContent = name;
        title.style = "font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
        const meta = document.createElement('div');
        meta.textContent = `${Math.round(file.size/1024)} KB`;
        meta.className = 'muted';
        meta.style = "font-size:12px";
        info.appendChild(title); info.appendChild(meta);

        const removeBtn = document.createElement('button');
        removeBtn.className = 'btn';
        removeBtn.textContent = 'Remover';
        removeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          filesMap.delete(name);
          renderList();
        });

        row.addEventListener('click', (e) => {
          if (e.target === removeBtn) return;
          try {
            const url = URL.createObjectURL(file);
            window.open(url, '_blank');
            setTimeout(() => URL.revokeObjectURL(url), 30000);
          } catch (_) {}
        });

        row.appendChild(info);
        row.appendChild(removeBtn);
        listEl.appendChild(row);
      }
    }

    function addFilesFromList(fileList) {
      for (const f of Array.from(fileList)) {
        if (!f.name.toLowerCase().endsWith('.pdf')) continue;
        if (filesMap.has(f.name)) continue; // evitar duplicatas por nome
        filesMap.set(f.name, f);
      }
      renderList();
    }

    // ligar botão do header para abrir modal
    const headerAddBtn = document.getElementById('btn-add-files');
    if (headerAddBtn) {
      headerAddBtn.addEventListener('click', (e) => {
        e.preventDefault();
        modalOpen();
      });
    }

    btnAddMore.addEventListener('click', () => inputHidden.click());
    btnClear.addEventListener('click', () => { filesMap.clear(); renderList(); });

    inputHidden.addEventListener('change', (ev) => {
      addFilesFromList(ev.target.files || []);
      inputHidden.value = "";
    });

    btnCancel.addEventListener('click', (e) => { e.preventDefault(); modalClose(); });

    btnStart.addEventListener('click', async (e) => {
      e.preventDefault();
      if (filesMap.size === 0) { alert('Nenhum arquivo para enviar.'); return; }
      if (!confirm(`Enviar ${filesMap.size} arquivo(s) para o servidor?`)) return;

      const form = new FormData();
      for (const f of filesMap.values()) form.append('files', f);

      if (progressWrap) progressWrap.style.display = 'block';
      if (progressText) progressText.textContent = '...';

      btnStart.disabled = true; btnAddMore.disabled = true; btnClear.disabled = true;

      try {
        const headers = {};
        if (csrfToken) headers['X-CSRFToken'] = csrfToken;
        const resp = await fetch('/api/upload', { method: 'POST', body: form, headers });
        const data = await resp.json();
        if (data && data.status === 'ok') {
          location.reload();
        } else {
          alert('Erro no upload: ' + (data?.error || JSON.stringify(data)));
          btnStart.disabled = false; btnAddMore.disabled = false; btnClear.disabled = false;
          if (progressWrap) progressWrap.style.display = 'none';
        }
      } catch (err) {
        console.error('upload error', err);
        alert('Erro ao enviar: ' + err.message);
        btnStart.disabled = false; btnAddMore.disabled = false; btnClear.disabled = false;
        if (progressWrap) progressWrap.style.display = 'none';
      }
    });

    // fecha modal ao clicar no backdrop
    modal.addEventListener('click', (e) => {
      if (e.target.classList.contains('modal-backdrop')) modalClose();
    });
  })();

  // ---------- Wire Controls (principal) ----------
  function wireControls() {
    // abre PDF ao clicar no card (não em botões)
    document.querySelectorAll('.thumb-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        const f = card.dataset.fname;
        if (!f) return;
        loadPdf(f, 1);
      });
    });

    // render thumbnails on init
    renderAllThumbnails();

    // remover (apenas botão delete nas miniaturas)
    document.querySelectorAll('.thumb-card .delete').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const f = btn.dataset.file;
        if (!f) return;
        if (!confirm(`Remover ${f} da lista? (original em /input permanece)`)) return;
        try {
          const res = await apiJson('/api/delete', 'POST', { filename: f });
          if (res && res.status === 'ok') {
            const el = document.querySelector(`.thumb-card[data-fname="${CSS.escape(f)}"]`);
            if (el) el.remove();
            filesOrder = filesOrder.filter(x => x !== f);
            if (currentFile === f) {
              currentFile = null;
              if (canvas) { canvas.width = 0; canvas.height = 0; }
              if (placeholder) { placeholder.style.display = 'flex'; placeholder.textContent = 'Selecione um arquivo...'; }
              const cf = document.getElementById('current-filename'); if (cf) cf.textContent = 'Selecione um arquivo...';
            }
            renderAllThumbnails();
          } else {
            alert('Erro: ' + (res?.error || JSON.stringify(res)));
          }
        } catch (err) {
          console.error('delete error', err);
          alert('Erro ao deletar: ' + err.message);
        }
      });
    });

    // viewer navigation
    const prevBtn = document.getElementById('prev-page');
    const nextBtn = document.getElementById('next-page');
    const pageGo = document.getElementById('page-go');
    const zoomIn = document.getElementById('zoom-in');
    const zoomOut = document.getElementById('zoom-out');

    if (prevBtn) prevBtn.addEventListener('click', async () => { if (!pdfDoc) return; if (currentPage > 1) { currentPage -= 1; await renderPage(currentPage); } });
    if (nextBtn) nextBtn.addEventListener('click', async () => { if (!pdfDoc) return; if (currentPage < totalPages) { currentPage += 1; await renderPage(currentPage); } });
    if (pageGo) pageGo.addEventListener('change', async (e) => {
      const v = parseInt(e.target.value, 10);
      if (!pdfDoc || Number.isNaN(v)) return;
      currentPage = Math.min(Math.max(1, v), totalPages);
      await renderPage(currentPage);
    });
    if (zoomIn) zoomIn.addEventListener('click', async () => { scale = Math.min(scale + 0.25, 3.0); if (pdfDoc) await renderPage(currentPage); });
    if (zoomOut) zoomOut.addEventListener('click', async () => { scale = Math.max(scale - 0.25, 0.25); if (pdfDoc) await renderPage(currentPage); });

    // toggle sidebar
    const toggleSidebar = document.getElementById('toggle-sidebar');
    if (toggleSidebar) {
      toggleSidebar.addEventListener('click', () => {
        const sb = document.getElementById('sidebar');
        if (!sb) return;
        sb.classList.toggle('collapsed');
        if (window.innerWidth < 900) sb.classList.toggle('show');
      });
    }

    // header quick-upload (input hidden + buttons)
    const headerInput = document.getElementById('upload-files');
    const headerAddBtn = document.getElementById('btn-add-files'); // abre modal already
    const headerUploadBtn = document.getElementById('btn-upload');

    if (headerInput) {
      headerInput.addEventListener('change', async (ev) => {
        const files = Array.from(ev.target.files || []);
        if (!files.length) return;
        // enviar direto (quick-upload) — valida
        for (const f of files) {
          if (!f.name.toLowerCase().endsWith('.pdf')) { alert(`Arquivo inválido: ${f.name}`); return; }
        }
        if (!confirm(`Enviar ${files.length} arquivo(s) selecionados rapidamente?`)) { headerInput.value = ""; return; }
        // FormData
        const form = new FormData();
        for (const f of files) form.append('files', f);
        try {
          const headers = {};
          if (csrfToken) headers['X-CSRFToken'] = csrfToken;
          const res = await fetch('/api/upload', { method: 'POST', body: form, headers });
          const data = await res.json();
          if (data && data.status === 'ok') location.reload();
          else alert('Erro no envio: ' + (data?.error || JSON.stringify(data)));
        } catch (err) {
          console.error('quick upload error', err);
          alert('Erro no envio: ' + err.message);
        } finally {
          headerInput.value = "";
        }
      });
    }

    if (headerUploadBtn) {
      headerUploadBtn.addEventListener('click', () => {
        // aciona seletor do header
        const inp = document.getElementById('upload-files');
        if (inp) inp.click();
      });
    }

    // delete-all (nova sessão)
    const btnDeleteAll = document.getElementById('btn-delete-all');
    if (btnDeleteAll) {
      btnDeleteAll.addEventListener('click', async () => {
        if (!confirm('Confirma apagar TODOS os PDFs e iniciar nova sessão? Esta ação é irreversível.')) return;
        btnDeleteAll.disabled = true;
        try {
          const res = await apiJson('/api/delete-all', 'POST', {});
          if (res && (res.status === 'ok' || res.status === 'partial')) {
            location.reload();
          } else {
            alert('Erro ao apagar tudo: ' + (res?.error || JSON.stringify(res)));
            btnDeleteAll.disabled = false;
          }
        } catch (err) {
          console.error('delete-all error', err);
          alert('Erro ao apagar tudo: ' + err.message);
          btnDeleteAll.disabled = false;
        }
      });
    }

    // BOTÃO ÚNICO: rotaciona +90° sempre (viewer)
    (function setupRotateCurrent() {
      const rotateBtn = document.getElementById('rotate-current');
      if (!rotateBtn) return;
      let busy = false;
      rotateBtn.addEventListener('click', async () => {
        if (busy) return;
        if (!currentFile || !pdfDoc) { alert('Abra um arquivo para rotacionar a página atual.'); return; }
        busy = true;
        rotateBtn.disabled = true;
        const pageIndex = currentPage - 1;
        try {
          const res = await apiJson('/api/rotate', 'POST', { filename: currentFile, page: pageIndex, direction: 'right' });
          if (res && res.status === 'ok') {
            const card = document.querySelector(`.thumb-card[data-fname="${CSS.escape(currentFile)}"]`);
            if (card) renderThumbnail(card, currentFile);
            await loadPdf(currentFile, pageIndex + 1);
            showRotateFeedback();
          } else {
            console.error('rotate-current API error', res);
            alert('Erro ao rotacionar: ' + (res?.error || JSON.stringify(res)));
          }
        } catch (err) {
          console.error('rotate-current error', err);
          alert('Erro ao rotacionar: ' + err.message);
        } finally {
          busy = false;
          rotateBtn.disabled = false;
        }
      });
      rotateBtn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); rotateBtn.click(); } });
    })();
  } // fim wireControls

  // ---------- Init ----------
  function init() {
    renderAllThumbnails();
    wireControls();
    if (filesOrder && filesOrder.length > 0 && filesOrder[0]) loadPdf(filesOrder[0], 1);
    else if (placeholder) { placeholder.style.display = 'flex'; placeholder.textContent = 'Selecione um arquivo...'; }
  }

  document.addEventListener('DOMContentLoaded', init);

})();
