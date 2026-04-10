let currentUserId = null;
let timerInterval = null;
let startTime = null;
let pendingDeleteId = null;
let isAdmin = sessionStorage.getItem('isAdmin') === 'true';
let isViewAuthenticated = sessionStorage.getItem('isViewAuthenticated') === 'true';

// Helper to normalize Polish state names for CSS classes
function getStateClass(state) {
    if (!state) return 'off';
    return state.toLowerCase()
        .replace(/ą/g, 'a')
        .replace(/ć/g, 'c')
        .replace(/ę/g, 'e')
        .replace(/ł/g, 'l')
        .replace(/ń/g, 'n')
        .replace(/ó/g, 'o')
        .replace(/ś/g, 's')
        .replace(/ź/g, 'z')
        .replace(/ż/g, 'z');
}

// --- Toast System ---
function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;

    const icons = {
        success: '✅',
        error: '❌',
        info: 'ℹ️'
    };

    toast.innerHTML = `
        <span class="toast-icon">${icons[type] || '🔔'}</span>
        <span class="toast-msg">${message}</span>
    `;

    container.appendChild(toast);

    // Auto-remove after 3.5s
    setTimeout(() => {
        toast.classList.add('hide');
        setTimeout(() => toast.remove(), 300);
    }, 3500);
}

// --- Dashboard Functions ---

async function fetchUsers() {
    try {
        const response = await fetch('/api/users');
        const users = await response.json();
        const grid = document.getElementById('userGrid');
        if (!grid) return;

        grid.innerHTML = users.map(user => {
            const stateClass = getStateClass(user.current_state);
            const statsHtml = user.daily_stats && user.daily_stats.length > 0
                ? user.daily_stats.map(s => `
                    <div style="display: flex; gap: 10px; margin-bottom: 2px;">
                        <span style="font-weight: 600; min-width: 90px; opacity: 0.9;">${s.state}:</span>
                        <span id="stat-${user.id}-${s.state}">${formatDuration(s.duration || 0)}</span>
                    </div>
                `).join('')
                : '<div style="opacity: 0.5;">Brak aktywności dzisiaj</div>';

            return `
                <div class="user-card" style="display: flex; flex-direction: column;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
                        <h3 style="margin: 0; font-size: 1.2rem;">${user.name}</h3>
                        <span class="status-badge status-${stateClass}" style="margin: 0;">
                            ${user.current_state || 'OFF'}
                        </span>
                    </div>
                    <div class="daily-breakdown" style="background: rgba(0,0,0,0.2); padding: 12px; border-radius: 12px; font-size: 0.85rem; margin-bottom: 1rem; flex-grow: 1;">
                        <div style="font-weight: 600; margin-bottom: 8px; font-size: 0.75rem; text-transform: uppercase; opacity: 0.5;">Dzisiaj:</div>
                        ${statsHtml}
                    </div>
                    
                    <div class="admin-only" style="justify-content: space-between; align-items: center; margin-top: auto; padding-top: 12px; border-top: 1px solid rgba(255,255,255,0.08);">
                        <div class="copy-link" data-id="${user.id}" style="margin: 0; opacity: 0.8; font-size: 0.85rem;">
                            🔗 Link
                        </div>
                        <button class="delete-user-btn" data-id="${user.id}" style="padding: 6px 12px; background: rgba(235, 77, 75, 0.1); color: #eb4d4b; border-radius: 8px; font-size: 0.75rem; border: 1px solid rgba(235, 77, 75, 0.3); cursor: pointer; transition: 0.2s;">USUŃ</button>
                    </div>
                </div>
            `;
        }).join('');

        // Refresh admin visibility
        updateAdminUI();
    } catch (err) {
        console.error('Error fetching users:', err);
    }
}

async function addUser() {
    const input = document.getElementById('userNameInput');
    const name = input.value.trim();
    if (!name) return;

    try {
        const response = await fetch('/api/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                name,
                password: sessionStorage.getItem('adminPassword')
            })
        });
        if (response.ok) {
            input.value = '';
            fetchUsers();
        } else {
            const errData = await response.json();
            showToast('Błąd: ' + errData.error, 'error');
        }
    } catch (err) {
        console.error('Error adding user:', err);
    }
}

function copyUserLink(id) {
    const url = `${window.location.origin}/user.html?id=${id}`;

    if (navigator.clipboard && navigator.clipboard.writeText) {
        // Modern approach (requires HTTPS)
        navigator.clipboard.writeText(url).then(() => {
            showToast('Link skopiowany!', 'success');
        }).catch(err => {
            console.error('Clipboard API failed, trying fallback:', err);
            fallbackCopyText(url);
        });
    } else {
        // Fallback for non-secure contexts (HTTP)
        fallbackCopyText(url);
    }
}

function fallbackCopyText(text) {
    const textArea = document.createElement("textarea");
    textArea.value = text;

    // Ensure it's not visible
    textArea.style.position = "fixed";
    textArea.style.left = "-9999px";
    textArea.style.top = "0";
    document.body.appendChild(textArea);

    textArea.focus();
    textArea.select();

    try {
        const successful = document.execCommand('copy');
        if (successful) {
            showToast('Link skopiowany!', 'success');
        } else {
            showToast('Nie udało się skopiować linku', 'error');
        }
    } catch (err) {
        console.error('Fallback copy failed:', err);
        showToast('Błąd podczas kopiowania', 'error');
    }

    document.body.removeChild(textArea);
}

async function deleteUser(id) {
    if (!isAdmin) return;

    if (confirm("Czy na pewno chcesz usunąć tego użytkownika?")) {
        try {
            const pass = sessionStorage.getItem('adminPassword');
            if (!pass) {
                showToast('Błąd: brak hasła w sesji', 'error');
                return;
            }

            const response = await fetch(`/api/users/${id}`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: pass })
            });

            if (response.ok) {
                showToast('Użytkownik usunięty', 'success');
                fetchUsers();
            } else {
                const errData = await response.json();
                showToast('Błąd: ' + errData.error, 'error');
            }
        } catch (err) {
            console.error('Error deleting user:', err);
        }
    }
}

function adminLogin() {
    const modal = document.getElementById('adminModal');
    const input = document.getElementById('adminPasswordInput');
    input.value = '';
    modal.classList.add('active');
    input.focus();
}

async function confirmLogin() {
    const pass = document.getElementById('adminPasswordInput').value;
    try {
        const response = await fetch('/api/admin-login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: pass })
        });

        if (response.ok) {
            isAdmin = true;
            sessionStorage.setItem('isAdmin', 'true');
            // Store password for subsequent delete actions in this session
            sessionStorage.setItem('adminPassword', pass);
            closeAdminModal();
            updateAdminUI();
        } else {
            showToast("Błędne hasło administratora!", "error");
        }
    } catch (err) {
        console.error('Login error:', err);
        showToast("Błąd połączenia z serwerem", "error");
    }
}

function adminLogout() {
    isAdmin = false;
    sessionStorage.removeItem('isAdmin');
    updateAdminUI();
}

function closeAdminModal() {
    document.getElementById('adminModal').classList.remove('active');
}

function updateAdminUI() {
    if (isAdmin) {
        document.body.classList.add('admin-mode');
    } else {
        document.body.classList.remove('admin-mode');
    }
}

async function viewLogin() {
    const pass = document.getElementById('viewPasswordInput').value;
    try {
        const response = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: pass })
        });

        if (response.ok) {
            isViewAuthenticated = true;
            sessionStorage.setItem('isViewAuthenticated', 'true');
            updateViewUI();
            startDashboardRefresh();
        } else {
            showToast("Błędne hasło dostępu!", "error");
        }
    } catch (err) {
        console.error('Login error:', err);
        showToast("Błąd połączenia z serwerem", "error");
    }
}

function updateViewUI() {
    const overlay = document.getElementById('accessOverlay');
    const container = document.getElementById('mainContainer');

    if (isViewAuthenticated) {
        if (overlay) overlay.style.display = 'none';
        if (container) container.style.display = 'block';
    } else {
        if (overlay) overlay.style.display = 'flex';
        if (container) container.style.display = 'none';
    }
}

// Old modal logic removed (confirmDelete, closeDeleteModal)


function formatDuration(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h}h ${m}m ${s}s`;
}

// --- User Switch Functions ---

async function initUserSwitch(id) {
    currentUserId = id;
    try {
        const response = await fetch(`/api/users/${id}`);
        const data = await response.json();

        document.getElementById('userNameHeading').textContent = data.user.name;

        // Find most recent active log
        const latest = data.logs[0];
        if (latest && !latest.end_time) {
            const positions = { 'OFF': 0, 'Przerwa': 1, 'Zbieranie': 2, 'Pakowanie': 3, 'Rozkładanie': 4, 'Inne': 5 };
            setUI(positions[latest.state], latest.state, false);
            startTimer(new Date(latest.start_time));
        } else {
            // No active session = OFF
            setUI(0, 'OFF', false);
            stopTimer();
        }

        renderLogs(data.logs);
    } catch (err) {
        console.error('Error loading user switch:', err);
    }
}

function startUserRefresh(id) {
    currentUserId = id;
    initUserSwitch(id);

    // Refresh every 30s as a backup
    if (window.userRefreshInterval) clearInterval(window.userRefreshInterval);
    window.userRefreshInterval = setInterval(() => initUserSwitch(id), 30000);

    // Real-time refresh via SSE
    connectSSE((data) => {
        if (!data || data.userId === id) {
            initUserSwitch(id);
        }
    });
}

async function setPos(pos, state) {
    const slider = document.getElementById('slider');
    const stateDisplay = document.getElementById('currentStateName');

    // UI Update
    slider.className = `switch-slider pos${pos}`;
    stateDisplay.textContent = `Stan: ${state}`;
    updateKnob(pos, state);

    // API Update
    try {
        const response = await fetch('/api/logs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: currentUserId, state })
        });

        if (response.ok) {
            if (state === 'OFF') {
                stopTimer();
            } else {
                startTimer(new Date());
            }
            // Refresh history
            initUserSwitch(currentUserId);
        }
    } catch (err) {
        console.error('Error setting state:', err);
    }
}

function setUI(pos, state, updateApi = true) {
    const slider = document.getElementById('slider');
    const stateDisplay = document.getElementById('currentStateName');
    slider.className = `switch-slider pos${pos}`;
    stateDisplay.textContent = `Stan: ${state}`;
    updateKnob(pos, state);
}

function startTimer(baseTime) {
    stopTimer();
    startTime = baseTime;
    timerInterval = setInterval(updateTimerUI, 1000);
}

function stopTimer() {
    if (timerInterval) clearInterval(timerInterval);
    document.getElementById('timer').textContent = "00:00:00";
}

function updateTimerUI() {
    const now = new Date();
    const diff = Math.floor((now - startTime) / 1000);

    const h = Math.floor(diff / 3600).toString().padStart(2, '0');
    const m = Math.floor((diff % 3600) / 60).toString().padStart(2, '0');
    const s = (diff % 60).toString().padStart(2, '0');

    document.getElementById('timer').textContent = `${h}:${m}:${s}`;
}

function renderLogs(logs) {
    const list = document.getElementById('logHistory');
    if (!list) return;

    list.innerHTML = logs.map(log => `
        <div style="background: rgba(255,255,255,0.05); padding: 10px; border-radius: 10px; display: flex; justify-content: space-between;">
            <span>${log.state}</span>
            <span style="opacity: 0.6; font-size: 0.8rem;">
                ${new Date(log.start_time).toLocaleTimeString()} - ${log.end_time ? new Date(log.end_time).toLocaleTimeString() : 'Trwa...'}
                (${log.duration_seconds || 0}s)
            </span>
        </div>
    `).join('');
}

// --- Rotary Knob ---

const KNOB_POS_DATA = [
    { pos: 0, state: 'OFF', angle: 30 },
    { pos: 1, state: 'Przerwa', angle: 90 },
    { pos: 2, state: 'Zbieranie', angle: 150 },
    { pos: 3, state: 'Pakowanie', angle: 210 },
    { pos: 4, state: 'Rozkładanie', angle: 270 },
    { pos: 5, state: 'Inne', angle: 330 }
];

function updateKnob(pos, state) {
    const sectors = document.querySelectorAll('.knob-sector');
    if (!sectors.length) return;

    sectors.forEach((s, i) => {
        s.classList.toggle('active', i === pos);
    });
}

function initKnobInteraction() {
    const svg = document.getElementById('knobSvg');
    if (!svg) return;

    // Tap on sector
    svg.querySelectorAll('.knob-sector').forEach(sector => {
        sector.addEventListener('click', () => {
            setPos(parseInt(sector.dataset.pos), sector.dataset.state);
        });
    });

    // Drag-to-rotate
    let dragging = false;

    function angleFromCenter(clientX, clientY) {
        const rect = svg.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        // angle from top, clockwise
        return (Math.atan2(clientX - cx, -(clientY - cy)) * 180 / Math.PI + 360) % 360;
    }

    function nearestPos(angle) {
        return KNOB_POS_DATA.reduce((best, kp) => {
            let d = Math.abs(angle - kp.angle);
            if (d > 180) d = 360 - d;
            let bd = Math.abs(angle - best.angle);
            if (bd > 180) bd = 360 - bd;
            return d < bd ? kp : best;
        }, KNOB_POS_DATA[0]);
    }

    // Touch
    svg.addEventListener('touchstart', (e) => { dragging = true; e.preventDefault(); }, { passive: false });
    svg.addEventListener('touchmove', (e) => {
        if (!dragging) return;
        const t = e.touches[0];
        const kp = nearestPos(angleFromCenter(t.clientX, t.clientY));
        updateKnob(kp.pos, kp.state);
        e.preventDefault();
    }, { passive: false });
    svg.addEventListener('touchend', (e) => {
        if (!dragging) return;
        dragging = false;
        const t = e.changedTouches[0];
        const kp = nearestPos(angleFromCenter(t.clientX, t.clientY));
        setPos(kp.pos, kp.state);
    });

    // Mouse (desktop testing)
    svg.addEventListener('mousedown', (e) => { dragging = true; });
    window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const kp = nearestPos(angleFromCenter(e.clientX, e.clientY));
        updateKnob(kp.pos, kp.state);
    });
    window.addEventListener('mouseup', (e) => {
        if (!dragging) return;
        dragging = false;
        const kp = nearestPos(angleFromCenter(e.clientX, e.clientY));
        setPos(kp.pos, kp.state);
    });
}

// Initial load
if (document.getElementById('userGrid')) {
    const grid = document.getElementById('userGrid');

    // Delegated Event Listeners
    grid.addEventListener('click', (e) => {
        const deleteBtn = e.target.closest('.delete-user-btn');
        const copyBtn = e.target.closest('.copy-link');

        if (deleteBtn) {
            const id = deleteBtn.getAttribute('data-id');
            deleteUser(id);
        } else if (copyBtn) {
            const id = copyBtn.getAttribute('data-id');
            copyUserLink(id);
        }
    });

    // Admin Event Listeners
    document.getElementById('adminLoginBtn').addEventListener('click', adminLogin);
    document.getElementById('adminLogoutBtn').addEventListener('click', adminLogout);
    document.getElementById('confirmLoginBtn').addEventListener('click', confirmLogin);
    document.getElementById('cancelLoginBtn').addEventListener('click', closeAdminModal);

    // View Access Event Listeners
    const confirmViewBtn = document.getElementById('confirmViewBtn');
    if (confirmViewBtn) {
        confirmViewBtn.addEventListener('click', viewLogin);
        document.getElementById('viewPasswordInput').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') viewLogin();
        });
    }

    // Enter key support for login
    document.getElementById('adminPasswordInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') confirmLogin();
    });

    // Close on escape
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeAdminModal();
    });

    updateViewUI();
    updateAdminUI();

    if (isViewAuthenticated) {
        startDashboardRefresh();
    }
}

function startDashboardRefresh() {
    fetchUsers();

    if (window.dashboardInterval) clearInterval(window.dashboardInterval);
    window.dashboardInterval = setInterval(fetchUsers, 10000); // Poll every 10s as backup

    connectSSE(fetchUsers);
}

function connectSSE(onUpdate) {
    if (window.appSSE) window.appSSE.close();

    const sse = new EventSource('/api/events');
    window.appSSE = sse;
    const statusEl = document.getElementById('sse-status');

    sse.addEventListener('update', (e) => {
        let data = null;
        try {
            data = JSON.parse(e.data);
        } catch (err) {
            console.error('Error parsing SSE data:', err);
        }
        if (typeof onUpdate === 'function') onUpdate(data);
    });

    sse.addEventListener('connected', () => {
        console.log('[SSE] Connected');
        if (statusEl) statusEl.classList.remove('visible');
    });

    sse.onerror = () => {
        console.warn('[SSE] Connection lost, reconnecting in 3s...');
        sse.close();
        if (statusEl) statusEl.classList.add('visible');

        // Reconnect after 3 seconds
        setTimeout(() => connectSSE(onUpdate), 3000);
    };
}
