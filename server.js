import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import path from 'path';
import cron from 'node-cron';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'dashboard.json');
const COMPANIES_FILE = path.join(__dirname, 'companies.json');

const HH_BASE_URL = 'https://api.hh.ru';
const HH_USER_AGENT = process.env.HH_USER_AGENT || 'VacancyMonitor/1.0 (monitor@example.com)';
const HH_APP_TOKEN = process.env.HH_APP_TOKEN || '';

app.use(express.static(path.join(__dirname, 'public')));

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function loadCompaniesConfig() {
  const raw = await fs.readFile(COMPANIES_FILE, 'utf-8');
  return JSON.parse(raw);
}

function buildHeaders() {
  const headers = {
    'User-Agent': HH_USER_AGENT,
    'HH-User-Agent': HH_USER_AGENT,
    'Accept': 'application/json'
  };

  if (HH_APP_TOKEN) {
    headers['Authorization'] = `Bearer ${HH_APP_TOKEN}`;
  }

  return headers;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    method: 'GET',
    headers: buildHeaders()
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HH API error ${response.status}: ${text}`);
  }

  return response.json();
}

async function fetchHHVacanciesByEmployer(employerId) {
  let allItems = [];
  let page = 0;
  let pages = 1;

  while (page < pages) {
    const url = `${HH_BASE_URL}/vacancies?employer_id=${encodeURIComponent(employerId)}&per_page=100&page=${page}&order_by=publication_time`;
    const data = await fetchJson(url);

    allItems = allItems.concat(data.items || []);
    pages = data.pages || 1;
    page += 1;
  }

  return allItems;
}

function detectCategory(title = '', description = '') {
  const text = `${title} ${description}`.toLowerCase();

  if (/медицинский представитель|продаж|sales|kam|key account/.test(text)) return 'ПРОДАЖИ';
  if (/маркетинг|brand|product manager|бренд/.test(text)) return 'МАРКЕТИНГ';
  if (/регистрац|regulatory/.test(text)) return 'РЕГИСТРАЦИЯ';
  if (/medical|медицинский советник|msl|фармаконадзор/.test(text)) return 'МЕДИЦИНА И НАУКА';
  if (/производств|технолог|инженер|оператор/.test(text)) return 'ПРОИЗВОДСТВО';
  if (/qa|qc|quality|качество|валидац/.test(text)) return 'КАЧЕСТВО';
  if (/аналитик|bi|данн|data/.test(text)) return 'АНАЛИТИКА';
  if (/hr|рекрутер|подбор персонала/.test(text)) return 'HR';
  if (/бухгалтер|финанс|юрист|офис|ассистент/.test(text)) return 'ОФИС';

  return 'ДРУГОЕ';
}

function mapHHVacancy(item, companyConfig) {
  const requirement = item?.snippet?.requirement || '';
  const responsibility = item?.snippet?.responsibility || '';
  const description = [requirement, responsibility].filter(Boolean).join(' • ');

  return {
    id: String(item.id),
    external_id: String(item.id),
    title: item.name || 'Без названия',
    company: item?.employer?.name || companyConfig.name,
    companyKey: companyConfig.name,
    city: item?.area?.name || 'Не указан',
    salary_from: item?.salary?.from ?? 0,
    salary_to: item?.salary?.to ?? 0,
    currency: item?.salary?.currency ?? 'RUR',
    description,
    responsibility,
    link: item.alternate_url || item.url || '#',
    date: item.published_at ? item.published_at.slice(0, 10) : new Date().toISOString().slice(0, 10),
    published_at: item.published_at || new Date().toISOString(),
    source: 'HeadHunter',
    employer_id: item?.employer?.id || companyConfig.employerId,
    archived: Boolean(item.archived),
    status: item.archived ? 'archived' : 'active',
    category: detectCategory(item.name || '', description),
    fetched_at: new Date().toISOString()
  };
}

function buildCompaniesFromVacancies(vacanciesList, configList) {
  const map = new Map();

  for (const cfg of configList) {
    map.set(cfg.name, {
      id: cfg.employerId,
      name: cfg.name,
      city: '—',
      vacancies: 0,
      employees: null,
      founded: null,
      description: '',
      sourcesList: ['HeadHunter'],
      activeVacancies: false,
      hhUrl: `https://hh.ru/employer/${cfg.employerId}`,
      lastUpdate: null
    });
  }

  for (const vacancy of vacanciesList) {
    const key = vacancy.companyKey || vacancy.company;

    if (!map.has(key)) {
      map.set(key, {
        id: vacancy.employer_id || null,
        name: key,
        city: vacancy.city || '—',
        vacancies: 0,
        employees: null,
        founded: null,
        description: '',
        sourcesList: ['HeadHunter'],
        activeVacancies: false,
        hhUrl: vacancy.employer_id ? `https://hh.ru/employer/${vacancy.employer_id}` : '',
        lastUpdate: null
      });
    }

    const company = map.get(key);
    company.vacancies += 1;

    if (company.city === '—' && vacancy.city) {
      company.city = vacancy.city;
    }

    if (vacancy.status === 'active') {
      company.activeVacancies = true;
    }

    company.lastUpdate = vacancy.fetched_at;
  }

  return Array.from(map.values());
}

async function readStoredData() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {
      updated_at: null,
      vacancies: [],
      companies: []
    };
  }
}

async function writeStoredData(data) {
  await ensureDataDir();
  await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

async function updateAllData() {
  const companiesConfig = await loadCompaniesConfig();
  const allVacancies = [];

  for (const company of companiesConfig) {
    try {
      const items = await fetchHHVacanciesByEmployer(company.employerId);
      const mapped = items.map(item => mapHHVacancy(item, company));
      allVacancies.push(...mapped);
      console.log(`[OK] ${company.name}: ${mapped.length} вакансий`);
    } catch (error) {
      console.error(`[ERROR] ${company.name}: ${error.message}`);
    }
  }

  const companies = buildCompaniesFromVacancies(allVacancies, companiesConfig);

  const payload = {
    updated_at: new Date().toISOString(),
    vacancies: allVacancies.sort((a, b) => new Date(b.published_at) - new Date(a.published_at)),
    companies
  };

  await writeStoredData(payload);
  return payload;
}

app.get('/api/dashboard-data', async (req, res) => {
  try {
    const data = await readStoredData();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/update', async (req, res) => {
  try {
    const data = await updateAllData();
    res.json({
      success: true,
      updated_at: data.updated_at,
      vacancies: data.vacancies.length,
      companies: data.companies.length
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/api/health', async (req, res) => {
  const data = await readStoredData();
  res.json({
    status: 'ok',
    updated_at: data.updated_at,
    vacancies: data.vacancies.length,
    companies: data.companies.length
  });
});

cron.schedule(process.env.UPDATE_CRON || '0 7 * * *', async () => {
  console.log('[CRON] Запуск обновления HH...');
  try {
    await updateAllData();
    console.log('[CRON] Обновление завершено');
  } catch (error) {
    console.error('[CRON] Ошибка обновления:', error.message);
  }
});

app.listen(PORT, async () => {
  console.log(`Сервер запущен: http://localhost:${PORT}`);

  await ensureDataDir();

  const current = await readStoredData();
  if (!current.updated_at) {
    console.log('Первичная загрузка вакансий...');
    try {
      await updateAllData();
      console.log('Первичная загрузка завершена');
    } catch (error) {
      console.error('Ошибка первичной загрузки:', error.message);
    }
  }
});
