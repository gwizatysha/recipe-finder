require('dotenv').config();
const os = require('os');
const path = require('path');
const express= require('express');
const helmet= require('helmet');
const rateLimit = require('express-rate-limit');

const PORT = Number(process.env.PORT) || 3000;

const API_KEY = process.env.MEALDB_API_KEY || '1';
const API_BASE = `https://www.themealdb.com/api/json/v1/${API_KEY}`;
const CACHE_TTL_MS = (Number(process.env.CACHE_TTL_SECONDS) || 300) * 1000;
const UPSTREAM_TIMEOUT_MS = 8000;
const HOSTNAME= os.hostname();

const app= express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(
    helmet({
        contentSecurityPolicy:{
            directives: {
                defaultSrc: ["'self'"],
                imgSrc: ["'self'", 'https://www.themealdb.com', 'data:'],
                scriptSrc: ["'self'"],
                styleSrc: ["'self'"],
                connectSrc: ["'self'"],
                frameSrc: ["'none'"],
                objectSrc: ["'none'"],
            },
        },
    })
);

app.use((req, res, next) => {
    res.setHeader('X-Served-By', HOSTNAME);
    next();
});

app.use(
    '/api/',
    rateLimit({
        windowMs: 60*1000,
        limit: 120,
        standardHeaders: true,
        legacyHeaders: false,
        message: {error: 'Too many requests. Please slow down and try again shortly.'},

    })
);

const cache = new Map();
function cacheGet(key){
    const hit = cache.get(key);
    if(!hit) return null; 
    if(Date.now()> hit.expires) {
        cache.delete(key);
        return null;
    }
    return hit.value;
}

function cacheSet(key,value) {
    if (cache.size >500) cache.delete(cache.keys().next().value);
    cache.set(key, {value, expires: Date.now() + CACHE_TTL_MS});
}


const TEXT_RE = /^[\p{L}\p{N} '\-.]{1,60}$/u;
const ID_RE= /^\d{1,8}$/;

function cleanText(value){
    if(typeof value !== 'string') return null;
    const trimmed= value.trim();
    return TEXT_RE.test(trimmed) ? trimmed: null;
}

class HttpError extends Error{
    constructor(status, message){
        super(message);
        this.status = status;
    }
}

async function mealdb(endpoint, params = {}){
    const url = new URL(`${API_BASE}/${endpoint}`);
    for (const [k,v] of Object.entries(params)) url.searchParams.set(k,v);
    const key = url.toString();

    const cached = cacheGet(key);
    if (cached) return cached;

    let response;
    try{
        response= await fetch(url, {signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)});
    } catch(err){
        throw new HttpError(504, 'The recipe service did not respond in time. Please try again' );
    }
    if (!response.ok){
        throw new HttpError(502, `The recipe service returned at error (${response.status}).`);
    }

    let data;
    try{
        data = await response.json();
    } catch (err){
        throw new HttpError(502, 'The recipe service returned an invalid response');
    }

    cacheSet(key, data);
    return data;
}

const mealsOf = (data) => (data && Array.isArray(data.meals) ? data.meals : []);

function toSummary(m) {
    return{ id: m.idMeal, name: m.strMeal, thumb:m.strMealThumb};
}

function toDetail(m){
    const ingredients = [];
    for (let i = 1; i <= 20; i++) {
        const name = (m[`strIngredient${i}`] || ''). trim();
        const measure = (m[`strMeasure${i}`] || ''). trim();
        if (name) ingredients.push({name,measure});
    }

    return{
        id: m.idMeal,
        name: m.strMeal,
        category: m.strCategory,
        area: m.strArea,
        instructions: m.strInstructions, 
        thumb: m.strMealThumb,
        tags: m.strTags ? m.strTags.split(',').map((t) => t.trim()). filter(Boolean) :[],
        youtube: m.strYoutube || null,
        source: m.strSource || null,
        ingredients,
    };
}

const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);

app.get('/api/health', (req, res) => {
    res.json({status:'ok', server: HOSTNAME, time: new Date().toISOString()});
}); 

app.get(
    '/api/search',
    wrap(async(req, res)=>{
        const q = cleanText(req.query.q);
        if(!q) throw new HttpError(400, 'Enter a search term (letters and numbers only, max 60 characters).');
        const data = await mealdb('search.php', {s:q});
        res.json({results: mealsOf(data).map(toDetail)});
    })
); 

app.get(
    '/api/browse', 
    wrap(async(req,res) => {
        const options = {c: req.query.category, a:req.query.area, i: req.query.ingredient};
        const provided = Object.entries(options).filter(([, v]) => v !== undefined && v !== '');
        if(provided.length !==1){
            throw new HttpError(400, 'Provide exactly one of: category, area, ingredient.');
        }
        const [param, raw] = provided[0];
        const value = cleanText(raw);
        if(!value) throw new HttpError(400, 'Invalid fliter value.');
        const data = await mealdb('filter.php', {[param]: value});
        res.json({results: mealsOf(data).map(toSummary)});
    })
);
app.get(
    '/api/recipe/:id',
    wrap(async(req,res)=> {
        if(!ID_RE.test(req.params.id)) throw new HttpError(400,'Invalid recipe id.');
        const data = await mealdb('lookup.php', {i: req.params.id});
        const meal = mealsOf(data)[0];
        if(!meal) throw new HttpError(404, 'Recipe not found');
        res.json(toDetail(meal));
    })
);

app.get(
    '/api/random',
    wrap(async(req,res)=> {
        let response;
        try{
            response = await fetch(`${API_BASE}/random.php`, {signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)});
        }catch (err){
            throw new HttpError(504, 'The recipe service did not respond in time. Please try again');
        }
        if (!response.ok) throw new HttpError(502, 'The recipe service returned an error');
        const data= await response.json().catch(() =>null);
        const meal = mealsOf(data)[0];
        if (!meal) throw new HttpError(502, 'The recipe service returned an invalid response.');
        res.json(toDetail(meal));
    })
);

app.get(
    '/api/categories',
    wrap(async(req, res)=> {
        const data = await mealdb('list.php', {c:'list'});
        res.json({results: mealsOf(data).map((m)=> m.strCategory).sort()});
    })
);

app.get(
    '/api/areas',
    wrap(async(req,res) => {
        const data = await mealdb('list.php', {a: 'list'});
        res.json({results: mealsOf(data).map((m)=> m.strArea).sort()});
    })
)

app.use('/api', (req,res) => res.status(404).json({error:'Unknown API endpoint.'}));

app.use(express.static(path.join(__dirname, 'public'), {maxAge:'1h'}));

app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status >= 500) console.error(`[${new Date().toISOString()}]`, err.message);
    res.status(status).json({error: status === 500 ? 'Something went wrong on the server.' : err.message});
});

if (require.main === module){
    app.listen(PORT, () => console.log(`Recipe Finder running on port ${PORT} (host: ${HOSTNAME})`));
}

module.exports = app;