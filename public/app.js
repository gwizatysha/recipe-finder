(() => {
    'use strict';
    const $ = (id) => document.getElementById(id);
    const els= {
        form : $('search-form'), q: $('q'), ingredient: $('ingredient'), 
        category: $('category'), area: $('area'), sort: $('sort'),
        random: $('random-btn'), favBtn: $('favorites-btn'), favCount: $('fav-count'),
        reset: $('reset-btn'), status: $('status'), error: $('error'),
        results: $('results'), modal: $('modal'), modalBody: $('modal-body'),
        modalClose: $('modal-close'), servedBy: $('served-by'),

    };

    const FAV_KEY = 'recipe-finder:favorites';
    let current = [];
    let showingFavorites = false;

    function el(tag, props = {}, children =[]){
        const node = document.createElement(tag);
        for (const [k, v] of Object.entries(props)){
            if (k === 'text') node.textContent = v;
            else if (k === 'class') node.className = v;
            else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
            else node.setAttribute(k,v);
        }
        for(const c of [].concat(children)) if (c) node.append(c);
        return node;
    }

    function safeUrl(url){
        try{
            const u = new URL(url);
            return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null; 
            } catch{return null; }
    }
    
    async function api(path) {
        let res;
        try{
            res = await fetch(path, {headers: {Accept: 'application/json'}});
        } catch{
            throw new Error('Cannot reach the server. Check your connection and try again.');
        }
        const servedBy = res.headers.get('X-Served-By');
        if (servedBy) els.servedBy.textContent = servedBy;
        let body = null;
        try{body = await res.json();} catch{}
        if (!res.ok) throw new Error((body && body.error) || `Request failed (${res.status}).`);
        if (!body) throw new Error('The server sent an unreadable response.');
        return body;
    }

    function loadFavorites(){
        try{return JSON.parse(localStorage.getItem(FAV_KEY)) || {}; } catch{return{}; }
    }
    function saveFavorites(favs){
        try{localStorage.setItem(FAV_KEY, JSON.stringify(favs)); } catch{}
        els.favCount.textContent = Object.keys(favs).length;
    }
    function setStatus(msg) {els.status.textContent= msg; }
    function showError (msg, retry){
        els.error.replaceChildren(el('span', {text: msg})); 
        if (retry) els.error.append(el('button', {type:'button', text: 'Retry', onclick: retry}));
        els.error.hidden = false;
    }
    function clearError(){
        els.error.hidden = true; els.error.replaceChildren();}
    
    function sorted(list){
        const dir = els.sort.value == 'za' ? -1 : 1;
        return [...list]. sort((a,b) => dir * a.name.localeCompare(b.name));
    }

    function render(){
        const list = sorted(showingFavorites ? Object.values(loadFavorites()): current);
        const favs = loadFavorites();
        els.results.replaceChildren(
            ...list.map((r) => {
                const isFav= Boolean(favs[r.id]);
                const badges = el('div', {class: 'badges'}, [
                    r.category && el('span', {class: 'badge', text: r.category}),
                    r.area && el('span', {class: 'badge', text: r.area}),
                ]);
                return el('article', {class: 'card'}, [
                    el('img', {src: `${r.thumb}/preview`, alt: r.name, loading: 'lazy'}),
                    el('button', {
                        type: 'button',
                        class: `fav-toggle${isFav ? ' on' : ''}`, 
                        'aria-pressed': String(isFav),
                        'aria-label': `${isFav ? 'Remove' : 'Add'} ${r.name} ${isFav ? 'from' : 'to'} favorites`,
                        text: isFav ? '★' : '☆',
                        onclick : () => toggleFavorite(r), 
                    }),
                    el('div', {class: 'body'}, [
                        el('h3', {text : r.name}), 
                        badges, 
                        el('button', {type: 'button', class: 'view primary', text: 'View recipe', onclick : () => openRecipe(r.id)}),
                    ]),
                ]);
            })
        );
    }

    function toggleFavorite(r){
        const favs = loadFavorites();
        if (favs[r.id]) delete favs[r.id];
        else favs[r.id] = {id: r.id, name: r.name, thumb: r.thumb, category: r.category, area:r.area};
        saveFavorites(favs);
        if (showingFavorites) setStatus(`${Object.keys(favs).length} favorite recipe(s).`);
        render();
    }
    async function openRecipe(id){
        clearError();
        try{
            showDetail(await api(`/api/recipe/${encodeURIComponent(id)}`));
        } catch (err) {
            showError(err.message, () => openRecipe(id));
        }
    }

    function showDetail(r) {
        const link = (label, url) => {
            const href = safeUrl(url);
            return href && el('a', {href, target: '_blank', rel:'noopener noreferrer', text: label});
        };
        els.modalBody.replaceChildren(
            el('img', {src: r.thumb, alt: r.name}),
            el('h2', {id: 'modal-title', text: r.name}),
            el('div', {class: 'badges'}, [
                r.category && el('span', { class: 'badge', text: r.category }),
                r.area && el('span', {class: 'badge', text: r.area}),
                ...r.tags.map((t) => el('span', {class: 'badge', text: t})),
            ]),
            el('h3', {text: 'Ingredients'}),
            el('ul', {}, r.ingredients.map((i) => el('li', { text: `${i.measure} ${i.name}`. trim() }))),
            el('h3', {text: 'Instructions'}),
            el('p', {class: 'instructions', text: r.instructions || 'No instructions provided.'}),
            el('p', {}, [link('Watch on Youtube', r.youtube), r.youtube && r.source ? '.' : null, link('Original source', r.source)]));
            els.modal.showModal();
    }

    async function runSearch() {
        clearError();
        showingFavorites = false;
        els.favBtn.setAttribute('aria-pressed', 'false');

        const q = els.q.value.trim();
        const ingredient = els.ingredient.value.trim();
        const category = els.category.value;
        const area= els.area.value;

        if (!q && !ingredient && !category && !area){
            current =[];
            render();
            setStatus('Enter a dish name or pick a filter to start.');
            return;
        }

        setStatus('Loading recipes...');
        els.results.setAttribute('aria-busy', 'true');
        try{
            if (q) {
                const {results} = await api(`/api/search?q=${encodeURIComponent(q)}`);
                const ing = ingredient.toLowerCase();
                current = results.filter(
                    (r) =>
                    (!category || r.category === category) &&
                    (!area || r.area === area) &&
                    (!ing || r.ingredients.some((i) => i.name.toLowerCase(). includes (ing)))
                );
            }else {
                const requests = [];
                if (ingredient) requests.push(api(`/api/browse?ingredient=${encodeURICompenent(ingredient)}`));
                if (category) requests.push(api(`/api/browse?category=${encodeURIComponent(category)}`));
                if(area) requests.push(api(`/api/browse?area=${encodeURIComponent(area)}`));
                const lists = (await Promise.all (requests)). map((r) => r.results);
                const [first, ...rest] = lists;
                current = first.filter((r) => rest.every((l) => l.some((x) => x.id === r.id)));
                current = current.map ((r) => ({...r, category: category || undefined, area: area || undefined}));
            }
            render();
            setStatus(
                current.length
                ? `${current.length} recipe${current.length === 1 ? '' : 's'} found.`
                : 'No recipes matched. Try a broader search or fewer filters.'
            ); 
        } catch (err){
            current =[];
            render();
            setStatus('');
            showError(err.message, runSearch);
        } finally {
            els.results.removeAttribute('aria-busy');
        }
    }
    async function surprise(){
        clearError();
        try{
            showDetail(await api('/api/random'));
        } catch(err) {
            showError(err.message, surprise);
        }
    }
    async function populateFilters(){
        try{
            const [cats, areas] = await Promise.all([api('/api/categories'), api('/api/areas')]);
            for (const c of cats.results) els.category.append(el('option', {value: c, text: c}));
            for( const a of areas.results) els.area.append(el('option', {value: a, text: a}));
        } catch (err){
            showError(`Filters could not be loaded: ${err.message}`, populateFilters);

        }
    }
    els.form.addEventListener('submit', (e) => {e.preventDefault(); runSearch(); });
    els.sort.addEventListener('change', render);
    els.random.addEventListener('click', surprise);
    els.favBtn.addEventListener('click', () => {
        showingFavorites = !showingFavorites;
        els.favBtn.setAttribute('aria-pressed', String(showingFavorites));
        clearError();
        if(showingFavorites){
            const n= Object.keys(loadFavorites()).length;
            setStatus(n ? `${n} favorite recipe${n === 1 ? '' : 's'}.` : 'No favorites yet. Tap ☆ on a recipe to save it.');
            render();
        } else{
            setStatus(current.length ? `${current.length} recipes found.` : '');
            render();
        }
    });
    els.reset.addEventListener('click', () => {
        els.form.reset();
        current = [];
        showingFavorites = false;
        els.favBtn.setAttribute('aria-pressed', 'false');
        clearError();
        setStatus('');
        render();
    });

    els.modalClose.addEventListener('click', () => els.modal.close());
    els.modal.addEventListener('click', (e) => { if (e.target === els.modal) els.modal.close(); });

    saveFavorites(loadFavorites());
    populateFilters();

    api('/api/health').catch(() => {});
})();