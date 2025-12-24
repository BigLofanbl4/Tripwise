const API_URL = '/api';

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

    const res = await fetch(`${API_URL}${endpoint}`, options);
    if (res.status === 401 || res.status === 403) logout();
    return res;
}