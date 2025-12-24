const API_URL = (window.location.protocol === 'file:' || (window.location.hostname === 'localhost' && window.location.port && window.location.port !== '3000'))
    ? 'http://localhost:3000/api'
    : '/api';

// Утилиты
const getToken = () => localStorage.getItem('token');
const saveToken = (token) => localStorage.setItem('token', token);
const logout = () => { localStorage.removeItem('token'); window.location.href = '/index.html'; };

async function fetchAPI(endpoint, method = 'GET', body = null) {
    const headers = { 'Content-Type': 'application/json' };
    const token = getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const options = { method, headers };
    if (body) options.body = JSON.stringify(body);

    console.log(API_URL);
    console.log(`[fetchAPI] ${method} ${API_URL}${endpoint}`, body ? `body=${JSON.stringify(body)}` : '');

    const res = await fetch(`${API_URL}${endpoint}`, options);
    if (res.status === 401 || res.status === 403) logout();
    return res;
}