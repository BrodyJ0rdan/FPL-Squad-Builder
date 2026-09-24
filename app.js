// FPL API endpoints 
const FPL_API_BASE = 'https://fantasy.premierleague.com/api';
const BOOTSTRAP_STATIC = `${FPL_API_BASE}/bootstrap-static/`;
const FIXTURES = `${FPL_API_BASE}/fixtures/`;
const TEAM_ENTRY = (teamId) => `${FPL_API_BASE}/entry/${teamId}/`;
const TEAM_PICKS = (teamId, gw) => `${FPL_API_BASE}/entry/${teamId}/event/${gw}/picks/`;

// CORS routes to try in order (the FPL API doesn't send CORS headers itself)
// Opened by double-clicking index.html? The browser then reports its origin as "null"
// and third-party proxies refuse it. Use `node server.js` and http://localhost:3000 instead.
const IS_FILE = location.protocol === 'file:';
const IS_LOCALHOST = ['localhost', '127.0.0.1'].includes(location.hostname);
const IS_GITHUB_PAGES = location.hostname.endsWith('github.io');

// Optional: paste your Cloudflare Worker address here (see cloudflare-worker.js), e.g.
// 'https://fpl-proxy.yourname.workers.dev'. It is only needed for "Load My Team" by ID.
const WORKER_URL = 'https://green-shadow-c3d2.brodyjordan10.workers.dev';

// On GitHub Pages the main data is downloaded into /data by the GitHub Action
// (.github/workflows/update-fpl-data.yml), so the browser reads it from the same site.
const LOCAL_DATA = {
    [BOOTSTRAP_STATIC]: 'data/bootstrap-static.json',
    [FIXTURES]: 'data/fixtures.json'
};
const USE_STATIC_DATA = !IS_FILE && !IS_LOCALHOST;

const PROXIES = [
    ...(WORKER_URL ? [u => WORKER_URL.replace(/\/$/, '') + u.replace(FPL_API_BASE, '/api')] : []),
    ...(IS_FILE || IS_GITHUB_PAGES ? [] : [u => u.replace(FPL_API_BASE, '/api')]), // server.js / same-origin proxy
    u => `https://corsproxy.io/?${encodeURIComponent(u)}`,
    u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    u => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
    u => u // direct, in case CORS is allowed
];
let workingProxy = 0;
let proxyConfirmed = false; // true once any route has returned data successfully
const FETCH_TIMEOUT_MS = 15000;

// Fetch JSON from the FPL API, falling back through the proxies (each with a timeout)
// and remembering the one that works
async function fplFetch(url) {
    // Hosted online (e.g. GitHub Pages): use the data files the GitHub Action keeps up to date
    if (USE_STATIC_DATA && LOCAL_DATA[url]) {
        try {
            const res = await fetch(`${LOCAL_DATA[url]}?t=${Math.floor(Date.now() / 60000)}`);
            if (res.ok) return await res.json();
        } catch (e) {
            console.warn('Static data file unavailable, trying live routes:', e.message);
        }
    }

    let lastErr;
    for (let i = 0; i < PROXIES.length; i++) {
        const idx = (workingProxy + i) % PROXIES.length;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(PROXIES[idx](url), { signal: controller.signal });
            if (res.status === 404 && proxyConfirmed) throw Object.assign(new Error('Not found (404)'), { fatal: true });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            workingProxy = idx;
            proxyConfirmed = true;
            return data;
        } catch (e) {
            if (e.fatal) throw e;
            console.warn(`Proxy ${idx} failed:`, e.message);
            lastErr = e;
        } finally {
            clearTimeout(timer);
        }
    }
    throw lastErr || new Error('All proxies failed');
}

// Team badge mapping (2026/27 Premier League)
const TEAM_BADGES = {
    'ARS': 'PLbadges/Arsenal-Logo.png',
    'AVL': 'PLbadges/AstonVilla-Logo.png',
    'BOU': 'PLbadges/Bournmouth-Logo.png',
    'BRE': 'PLbadges/Brentford-Logo.png',
    'BHA': 'PLbadges/Brighton-Logo.png',
    'CHE': 'PLbadges/Chelsea-Logo.png',
    'COV': 'PLbadges/CoventryCity-Logo.png',
    'CRY': 'PLbadges/CrystalPalace-Logo.png',
    'EVE': 'PLbadges/Everton-Logo.png',
    'FUL': 'PLbadges/Fulham-Logo.png',
    'HUL': 'PLbadges/HullCity-Logo.png',
    'IPS': 'PLbadges/IpswitchTown-Logo.png',
    'LEE': 'PLbadges/Leeds-Logo.png',
    'LIV': 'PLbadges/Liverpool-Logo.png',
    'MCI': 'PLbadges/ManchesterCity-Logo.png',
    'MUN': 'PLbadges/ManchesterUnited-Logo.png',
    'NEW': 'PLbadges/NewcastleUnited-Logo.png',
    'NFO': 'PLbadges/NottinghamForest-Logo.png',
    'SUN': 'PLbadges/Sunderland-Logo.png',
    'TOT': 'PLbadges/TottenhamHotspur-Logo.png'
};

// Local badge if we have one, otherwise the official badge via the team code from the API
function badgeSrc(shortName) {
    if (TEAM_BADGES[shortName]) return TEAM_BADGES[shortName];
    const t = allTeams.find(t => t.short_name === shortName);
    return t ? `https://resources.premierleague.com/premierleague/badges/70/t${t.code}.png`
             : 'PLbadges/default.png';
}

// Global data storage
let allPlayers = [];
let allTeams = [];
let allFixtures = [];
let userTeamData = null;
let userTeamPicks = null;
let initialBankBalance = 0; // Store the initial bank balance

// Data model
let baseTeam = [];
let transfers = [];
let swapOverrides = [];
let currentSort = { column: 'points', ascending: false };

let upcomingGW = null;
let maxGW = null;
let viewedGW = null;

// UI state for slot selection (swap)
let selectedSlotEl = null;

// Initialize app on load
let dataReady = null; // resolves when the FPL data has finished loading

document.addEventListener('DOMContentLoaded', () => {
    // Set the page up straight away so buttons and the modal work even while data loads
    initializeEventListeners();
    initializeGWControls();
    showTeamIdModal();

    dataReady = loadFPLData().then(() => {
        displayPlayers();
        displayFixtures();
        updateGWDisplay();
        updateTeamDisplay();
    });
});

// Show team ID modal
function showTeamIdModal() {
    const modal = document.getElementById('teamIdModal');
    if (!modal) return;
    modal.classList.add('active');
    
    // Focus on input
    const input = document.getElementById('teamIdInput');
    if (input) setTimeout(() => input.focus(), 100);
    
    // Allow Enter key to submit
    if (input) {
        input.onkeypress = function(e) {
            if (e.key === 'Enter') {
                loadUserTeam();
            }
        };
    }
}

// Load user's actual FPL team
async function loadUserTeam() {
    const input = document.getElementById('teamIdInput');
    const teamId = input ? input.value.trim() : '';
    
    if (!teamId || isNaN(teamId)) {
        alert('Please enter a valid team ID (numbers only)');
        return;
    }
    
    const loadingMsg = document.getElementById('loadingMessage');
    if (loadingMsg) loadingMsg.style.display = 'block';
    
    try {
        // Player data must be loaded before a team can be built from it
        if (dataReady) await dataReady;
        if (!allPlayers.length) {
            throw new Error('Player data has not loaded yet - check your connection and refresh the page.');
        }

        // Get team general info
        userTeamData = await fplFetch(TEAM_ENTRY(teamId));
        
        // Store the initial bank balance
        initialBankBalance = userTeamData.last_deadline_bank / 10;
        
        // Get current team picks - try the most recent gameweek first, then work backwards
        let picksLoaded = false;
        const currentEvent = userTeamData.current_event;
        
        const gameweeksToTry = [];
        if (currentEvent) {
            gameweeksToTry.push(currentEvent);
            for (let gw = currentEvent - 1; gw >= 1; gw--) {
                gameweeksToTry.push(gw);
            }
        } else {
            // Fallback if current event is not available
            for (let gw = maxGW || 38; gw >= 1; gw--) {
                gameweeksToTry.push(gw);
            }
        }
        
        for (const gw of gameweeksToTry) {
            try {
                const picksData = await fplFetch(TEAM_PICKS(teamId, gw));
                if (picksData.picks && picksData.picks.length > 0) {
                    userTeamPicks = picksData.picks;
                    picksLoaded = true;
                    break;
                }
            } catch (e) {
                console.log(`Failed to load GW ${gw}:`, e.message);
            }
        }
        
        if (!picksLoaded) {
            throw new Error('Could not load current team picks from any gameweek. Your team might be set to private.');
        }
        
        // Close modal and setup team
        document.getElementById('teamIdModal').classList.remove('active');
        setupUserTeam();
        
    } catch (error) {
        console.error('Error loading user team:', error);
        alert(`Failed to load team data: ${error.message}\n\nPlease check:\n- Team ID is correct\n- Team is set to public (not private)\n- Try again in a few moments`);
        if (loadingMsg) loadingMsg.style.display = 'none';
    }
}

// Skip team loading (demo mode)
function skipTeamLoad() {
    const modal = document.getElementById('teamIdModal');
    if (modal) modal.classList.remove('active');
    updateTeamDisplay();
}

// Setup user team data
function setupUserTeam() {
    if (!userTeamData) {
        console.error('Missing userTeamData');
        return;
    }
    
    if (!userTeamPicks) {
        console.error('Missing userTeamPicks - loading team info without picks');
    }
    
    // Display team info
    const teamInfoHeader = document.getElementById('teamInfoHeader');
    if (teamInfoHeader) teamInfoHeader.style.display = 'flex';
    
    const managerEl = document.getElementById('managerName');
    const teamNameEl = document.getElementById('teamName');
    const overallRankEl = document.getElementById('overallRank');
    const totalPointsEl = document.getElementById('totalPoints');
    const gameweekRankEl = document.getElementById('gameweekRank');
    if (managerEl) managerEl.textContent = `${userTeamData.player_first_name} ${userTeamData.player_last_name}`;
    if (teamNameEl) teamNameEl.textContent = userTeamData.name;
    if (overallRankEl) overallRankEl.textContent = userTeamData.summary_overall_rank?.toLocaleString() || '-';
    if (totalPointsEl) totalPointsEl.textContent = userTeamData.summary_overall_points?.toLocaleString() || '-';
    if (gameweekRankEl) gameweekRankEl.textContent = userTeamData.summary_event_rank?.toLocaleString() || '-';
    
    // If we have picks, setup baseTeam
    if (userTeamPicks && userTeamPicks.length > 0) {
        baseTeam = [];
        
        // Sort picks by their position field to maintain FPL order
        const sortedPicks = userTeamPicks.slice().sort((a, b) => a.position - b.position);
        
        sortedPicks.forEach(pick => {
            const player = allPlayers.find(p => p.id === pick.element);
            if (player) {
                baseTeam.push(pick.element);
                
                // Use the current market price for display
                player.sellPrice = player.price;
            } else {
                console.error('Player not found for ID:', pick.element);
            }
        });
    } else {
        baseTeam = [];
    }
    
    // Clear any existing transfers and swaps
    transfers = [];
    swapOverrides = [];
    
    // Update team display
    updateTeamDisplay();
}

// Fetch data from FPL API
async function loadFPLData() {
    try {
        const data = await fplFetch(BOOTSTRAP_STATIC);

        allTeams = data.teams;
        allPlayers = data.elements.map(player => ({
            id: player.id,
            name: `${player.first_name} ${player.second_name}`,
            team: allTeams.find(t => t.id === player.team)?.short_name || 'Unknown',
            teamId: player.team,
            position: getPositionName(player.element_type),
            price: player.now_cost / 10,
            sellPrice: player.now_cost / 10,
            customPrice: null,
            status: player.status, // 'u' = left the league
            points: player.total_points,
            goals: player.goals_scored,
            assists: player.assists,
            ppg: player.points_per_game ? parseFloat(player.points_per_game) : 0,
            form: player.form ? parseFloat(player.form) : 0,
            ownership: player.selected_by_percent ? parseFloat(player.selected_by_percent) : 0,
            minutes: player.minutes,
            yellowCards: player.yellow_cards,
            redCards: player.red_cards,
            bonus: player.bonus,
            cleanSheets: player.clean_sheets,
            saves: player.saves || 0,
            penaltiesSaved: player.penalties_saved || 0,
            penaltiesMissed: player.penalties_missed || 0,
            influence: player.influence,
            creativity: player.creativity,
            threat: player.threat,
            ictIndex: player.ict_index
        }));

        allFixtures = await fplFetch(FIXTURES);

        // Work out the upcoming gameweek from the API's own event flags
        // (a postponed old fixture can't pull this back to an earlier week)
        const events = data.events || [];
        const nextEv = events.find(e => e.is_next) || events.find(e => e.is_current) || events[events.length - 1];
        upcomingGW = nextEv ? nextEv.id : Math.min(...allFixtures.map(f => f.event || Infinity));
        maxGW = events.length
            ? Math.max(...events.map(e => e.id))
            : Math.max(...allFixtures.map(f => f.event || 0));
        viewedGW = upcomingGW;

        populateTeamFilter();
        configurePriceSlider();
    } catch (error) {
        console.error('Error loading FPL data:', error);
        const tbody = document.getElementById('playersTableBody');
        if (tbody) {
            tbody.innerHTML =
                `<tr><td colspan="11" style="text-align: center; color: red;">` +
                (IS_FILE
                    ? 'This page was opened as a file, so the browser blocks the FPL data. ' +
                      'Run <b>node server.js</b> in this folder, then open <b>http://localhost:3000</b>.'
                    : IS_GITHUB_PAGES
                    ? 'FPL data files not found yet. In your GitHub repo open <b>Actions → Update FPL data → Run workflow</b>, wait a minute, then refresh.'
                    : `Error loading data (${error.message}). <a href="#" onclick="location.reload(); return false;">Retry</a>`) +
                `</td></tr>`;
        }
    }
}

// Price slider range comes from the data instead of a hard-coded 3.5-15.0
function configurePriceSlider() {
    const slider = document.getElementById('priceFilter');
    if (!slider || !allPlayers.length) return;
    const prices = allPlayers.map(p => p.price);
    const min = Math.floor(Math.min(...prices) * 10) / 10;
    const max = Math.ceil(Math.max(...prices) * 10) / 10;
    slider.min = min;
    slider.max = max;
    slider.value = max;
    const label = document.getElementById('priceValue');
    if (label) label.textContent = `£${max.toFixed(1)}m`;
}

function getPositionName(elementType) {
    switch (elementType) {
        case 1: return 'GK';
        case 2: return 'DEF';
        case 3: return 'MID';
        case 4: return 'FWD';
        default: return 'Unknown';
    }
}

function initializeEventListeners() {
    // Navigation tabs
    document.querySelectorAll('.nav-tab').forEach(tab => {
        tab.addEventListener('click', (e) => {
            switchPage(e.target.dataset.page);
        });
    });

    // Filters
    const posFilter = document.getElementById('positionFilter');
    const teamFilter = document.getElementById('teamFilter');
    const priceFilter = document.getElementById('priceFilter');
    const searchFilter = document.getElementById('searchFilter');

    if (posFilter) posFilter.addEventListener('change', displayPlayers);
    if (teamFilter) teamFilter.addEventListener('change', displayPlayers);
    if (priceFilter) priceFilter.addEventListener('input', (e) => {
        const priceValueEl = document.getElementById('priceValue');
        if (priceValueEl) priceValueEl.textContent = `£${parseFloat(e.target.value).toFixed(1)}m`;
        displayPlayers();
    });
    if (searchFilter) searchFilter.addEventListener('input', displayPlayers);

    // Sort columns
    document.querySelectorAll('th[data-sort]').forEach(th => {
        th.addEventListener('click', () => sortTable(th.dataset.sort));
    });

    // Formation change triggers re-render
    const formationSelect = document.getElementById('formationSelect');
    if (formationSelect) formationSelect.addEventListener('change', updateTeamDisplay);
}

function switchPage(page) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));

    const pageEl = document.getElementById(page);
    if (pageEl) pageEl.classList.add('active');
    const tabEl = document.querySelector(`[data-page="${page}"]`);
    if (tabEl) tabEl.classList.add('active');

    if (page === 'fixtures') displayFixtures();
}

function populateTeamFilter() {
    const teamFilter = document.getElementById('teamFilter');
    if (!teamFilter) return;
    teamFilter.innerHTML = '<option value="">All Teams</option>';
    allTeams.forEach(team => {
        const option = document.createElement('option');
        option.value = team.short_name;
        option.text = team.name;
        teamFilter.appendChild(option);
    });
}

/* --- Players list --- */
function displayPlayers() {
    if (!allPlayers || allPlayers.length === 0) {
        const tbody = document.getElementById('playersTableBody');
        if (tbody) tbody.innerHTML = '<tr><td colspan="11" class="loading">Loading players...</td></tr>';
        return;
    }

    const position = document.getElementById('positionFilter')?.value || '';
    const team = document.getElementById('teamFilter')?.value || '';
    const maxPrice = parseFloat(document.getElementById('priceFilter')?.value || '100');
    const search = (document.getElementById('searchFilter')?.value || '').toLowerCase();

    let filteredPlayers = allPlayers.filter(player => {
        // Hide players who have left the league (unless they're in the loaded team)
        if (player.status === 'u' && !baseTeam.includes(player.id)) return false;
        if (position && player.position !== position) return false;
        if (team && player.team !== team) return false;
        if (!isNaN(maxPrice) && player.price > maxPrice) return false;
        if (search && !player.name.toLowerCase().includes(search)) return false;
        return true;
    });

    filteredPlayers.sort((a, b) => {
        const aVal = a[currentSort.column];
        const bVal = b[currentSort.column];
        if (typeof aVal === 'string') {
            return currentSort.ascending ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
        }
        return currentSort.ascending ? aVal - bVal : bVal - aVal;
    });

    const tbody = document.getElementById('playersTableBody');
    if (!tbody) return;
    tbody.innerHTML = '';

    if (filteredPlayers.length === 0) {
        tbody.innerHTML = '<tr><td colspan="11" style="text-align: center;">No players found matching your criteria</td></tr>';
        return;
    }

    filteredPlayers.slice(0, 100).forEach(player => {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td class="player-name">${player.name}</td>
            <td>
                <div class="team-badge-container">
                    <img src="${badgeSrc(player.team)}" 
                         alt="${player.team}" class="team-badge-img" 
                         onerror="this.src='PLbadges/default.png'">
                    ${player.team}
                </div>
            </td>
            <td>${player.position}</td>
            <td class="price">£${player.price.toFixed(1)}m</td>
            <td class="${getStatClass(player.points, 50, 100)}">${player.points}</td>
            <td>${player.goals}</td>
            <td>${player.assists}</td>
            <td class="${getStatClass(player.ppg, 3, 5)}">${player.ppg.toFixed(1)}</td>
            <td class="${getStatClass(player.form, 3, 5)}">${player.form.toFixed(1)}</td>
            <td>${player.ownership.toFixed(1)}%</td>
            <td><button class="btn btn-add" data-player-id="${player.id}">Add</button></td>
        `;
        // right-click on the player row -> edit price
        row.oncontextmenu = (e) => {
            e.preventDefault();
            const newVal = prompt(`Edit price for ${player.name}:`, player.price.toFixed(1));
            const parsed = parseFloat(newVal);
            if (!isNaN(parsed) && parsed > 0) {
                player.price = parsed;
                player.customPrice = parsed;
                if (baseTeam.includes(player.id)) {
                    player.sellPrice = parsed;
                }
                const priceCell = row.querySelector('.price');
                if (priceCell) priceCell.textContent = `£${player.price.toFixed(1)}m`;
                updateTeamDisplay();
            }
        };

        tbody.appendChild(row);
    });

    // Attach add buttons
    document.querySelectorAll('.btn-add').forEach(btn => {
        btn.addEventListener('click', () => {
            const pid = parseInt(btn.dataset.playerId);
            addToTeamForGW(pid, viewedGW);
        });
    });
}

function sortTable(column) {
    if (currentSort.column === column) currentSort.ascending = !currentSort.ascending;
    else {
        currentSort.column = column;
        currentSort.ascending = false;
    }

    document.querySelectorAll('th[data-sort]').forEach(th => {
        th.classList.remove('sorted', 'desc');
        if (th.dataset.sort === column) {
            th.classList.add('sorted');
            if (!currentSort.ascending) th.classList.add('desc');
        }
    });

    displayPlayers();
}

function getStatClass(value, med, high) {
    if (value >= high) return 'stat-high';
    if (value >= med) return 'stat-med';
    return 'stat-low';
}

/* --- Fixtures --- */
function displayFixtures() {
    const fixturesGrid = document.getElementById('fixturesGrid');
    if (!fixturesGrid) return;
    if (!allFixtures || allFixtures.length === 0) {
        fixturesGrid.innerHTML = '<div class="loading">Loading fixtures...</div>';
        return;
    }
    fixturesGrid.innerHTML = '';

    const teamFixtures = {};
    allTeams.forEach(team => {
        teamFixtures[team.id] = { name: team.name, shortName: team.short_name, fixtures: [] };
    });

    // Skip finished fixtures and unscheduled ones (postponed fixtures have event: null)
    const upcomingFixtures = allFixtures.filter(f => !f.finished && f.event).sort((a, b) => a.event - b.event);
    upcomingFixtures.forEach(fixture => {
        const home = fixture.team_h;
        const away = fixture.team_a;
        if (teamFixtures[home]) {
            teamFixtures[home].fixtures.push({
                opponent: teamFixtures[away]?.shortName || 'TBD',
                isHome: true,
                difficulty: fixture.team_h_difficulty || 3,
                gameweek: fixture.event
            });
        }
        if (teamFixtures[away]) {
            teamFixtures[away].fixtures.push({
                opponent: teamFixtures[home]?.shortName || 'TBD',
                isHome: false,
                difficulty: fixture.team_a_difficulty || 3,
                gameweek: fixture.event
            });
        }
    });

    Object.values(teamFixtures).forEach(team => {
        if (team.fixtures.length === 0) return;

        const teamDiv = document.createElement('div');
        teamDiv.className = 'team-fixtures';
        teamDiv.dataset.teamName = team.shortName;

        const header = document.createElement('div');
        header.className = 'team-header';
        header.innerHTML = `
            <img src="${badgeSrc(team.shortName)}" 
                 alt="${team.shortName}" class="team-badge-img"
                 onerror="this.src='PLbadges/default.png'">
            ${team.name}
        `;
        teamDiv.appendChild(header);

        const fixturesContainer = document.createElement('div');
        fixturesContainer.className = 'fixtures-container';

        const initialFixtures = team.fixtures.slice(0, 5);
        const remainingFixtures = team.fixtures.slice(5);

        initialFixtures.forEach(f => {
            const fixtureDiv = document.createElement('div');
            fixtureDiv.className = 'fixture';
            fixtureDiv.innerHTML = `
                <span>${f.isHome ? 'H' : 'A'} vs ${f.opponent} (GW${f.gameweek})</span>
                <span class="difficulty difficulty-${f.difficulty}">
                    ${getDifficultyText(f.difficulty)}
                </span>
            `;
            fixturesContainer.appendChild(fixtureDiv);
        });

        if (remainingFixtures.length > 0) {
            const remainingContainer = document.createElement('div');
            remainingContainer.className = 'remaining-fixtures';
            remainingContainer.style.display = 'none';

            remainingFixtures.forEach(f => {
                const fixtureDiv = document.createElement('div');
                fixtureDiv.className = 'fixture';
                fixtureDiv.innerHTML = `
                    <span>${f.isHome ? 'H' : 'A'} vs ${f.opponent} (GW${f.gameweek})</span>
                    <span class="difficulty difficulty-${f.difficulty}">
                        ${getDifficultyText(f.difficulty)}
                    </span>
                `;
                remainingContainer.appendChild(fixtureDiv);
            });

            fixturesContainer.appendChild(remainingContainer);

            const toggleButton = document.createElement('button');
            toggleButton.className = 'toggle-fixtures-btn';
            toggleButton.textContent = `Show all ${team.fixtures.length} fixtures`;
            toggleButton.addEventListener('click', (e) => {
                e.stopPropagation();
                const isExpanded = remainingContainer.style.display !== 'none';
                if (isExpanded) {
                    remainingContainer.style.display = 'none';
                    toggleButton.textContent = `Show all ${team.fixtures.length} fixtures`;
                } else {
                    remainingContainer.style.display = 'block';
                    toggleButton.textContent = 'Show fewer fixtures';
                }
            });

            fixturesContainer.appendChild(toggleButton);
        }

        teamDiv.appendChild(fixturesContainer);
        fixturesGrid.appendChild(teamDiv);
    });
}

function getDifficultyText(difficulty) {
    switch (difficulty) {
        case 1: return 'Very Easy';
        case 2: return 'Easy';
        case 3: return 'Medium';
        case 4: return 'Hard';
        case 5: return 'Very Hard';
        default: return 'Unknown';
    }
}

/* --- Gameweek controls --- */
function initializeGWControls() {
    const prevBtn = document.getElementById('gwPrev');
    const nextBtn = document.getElementById('gwNext');

    if (!prevBtn || !nextBtn) return;

    prevBtn.addEventListener('click', () => {
        if (viewedGW === null) return;
        if (viewedGW > 1) {
            viewedGW--;
            updateGWDisplay();
            updateTeamDisplay();
        }
    });

    nextBtn.addEventListener('click', () => {
        if (viewedGW === null) return;
        if (maxGW && viewedGW < maxGW) {
            viewedGW++;
            updateGWDisplay();
            updateTeamDisplay();
        }
    });

    updateGWDisplay();
}

function updateGWDisplay() {
    const currentLabel = document.getElementById('currentGW');
    if (!currentLabel) return;
    if (viewedGW === null) currentLabel.textContent = 'Gameweek -';
    else currentLabel.textContent = `Gameweek ${viewedGW}`;
}

/* --- Team timeline logic --- */

function computeTeamForGW(gw) {
    let teamIds = baseTeam.slice();
    const sortedTransfers = transfers.slice().sort((a, b) => a.gw - b.gw);
    sortedTransfers.forEach(t => {
        if (t.gw <= gw) {
            if (t.action === 'add') {
                if (!teamIds.includes(t.playerId)) teamIds.push(t.playerId);
            } else if (t.action === 'remove') {
                teamIds = teamIds.filter(id => id !== t.playerId);
            }
        }
    });
    const players = teamIds.map(id => allPlayers.find(p => p.id === id)).filter(Boolean);
    return players;
}

function getLatestSwapOverride(playerId, gw) {
    const relevant = swapOverrides
        .filter(s => s.playerId === playerId && s.gw <= gw)
        .sort((a, b) => b.gw - a.gw);
    return relevant.length ? relevant[0] : null;
}

/* --- Team management (GW-aware) --- */

function addToTeamForGW(playerId, gw) {
    const player = allPlayers.find(p => p.id === playerId);
    if (!player) return;

    const teamAtGW = computeTeamForGW(gw);

    if (teamAtGW.some(p => p.id === playerId)) {
        alert('Player already in team for this gameweek!');
        return;
    }

    const maxByPosition = { 'GK': 2, 'DEF': 5, 'MID': 5, 'FWD': 3 };
    const positionCount = teamAtGW.filter(p => p.position === player.position).length;
    const teamCount = teamAtGW.filter(p => p.teamId === player.teamId).length;

    if (positionCount >= (maxByPosition[player.position] || 0)) {
        alert(`Maximum ${maxByPosition[player.position]} ${player.position}s allowed for this GW!`);
        return;
    }

    if (teamAtGW.length >= 15) {
        alert('Team is full for this GW! Remove a player first.');
        return;
    }
    if (teamCount >= 3) {
        alert('Maximum 3 players from the same team allowed for this GW!');
        return;
    }

    const availableBudget = calculateAvailableBudget(teamAtGW);

    if (player.price > availableBudget) {
        alert(`Not enough budget! Available: £${availableBudget.toFixed(1)}m`);
        return;
    }

    transfers.push({ gw: gw, action: 'add', playerId: playerId });
    updateTeamDisplay();
}

function removeFromTeamForGW(playerId, gw) {
    const currentTeam = computeTeamForGW(gw);
    
    if (!currentTeam.some(p => p.id === playerId)) {
        alert('Player not in team for this gameweek.');
        return;
    }

    transfers.push({ gw: gw, action: 'remove', playerId: playerId });
    swapOverrides = swapOverrides.filter(s => !(s.playerId === playerId && s.gw >= gw));
    updateTeamDisplay();
}

function calculateCurrentTeamValue(team) {
    return team.reduce((sum, player) => {
        return sum + (player.sellPrice || player.price);
    }, 0);
}

function calculateAvailableBudget(team) {
    if (!userTeamData) {
        // Demo mode: 100m budget minus current team value
        return 100 - team.reduce((sum, p) => sum + (p.price || 0), 0);
    }
    
    // Calculate based on transfers from the base team
    const currentTeamValue = calculateCurrentTeamValue(team);
    const baseTeamValue = baseTeam.reduce((sum, playerId) => {
        const player = allPlayers.find(p => p.id === playerId);
        return sum + (player ? (player.sellPrice || player.price) : 0);
    }, 0);
    
    // Available = Initial bank + (money from sales) - (money spent on purchases)
    // = Initial bank + baseTeamValue - currentTeamValue
    const available = initialBankBalance + baseTeamValue - currentTeamValue;
    
    return Math.max(0, available);
}

function clearTeam() {
    if (confirm('Are you sure you want to clear your entire team?')) {
        baseTeam = [];
        transfers = [];
        swapOverrides = [];
        userTeamData = null;
        userTeamPicks = null;
        initialBankBalance = 0;
        const teamInfoHeader = document.getElementById('teamInfoHeader');
        if (teamInfoHeader) teamInfoHeader.style.display = 'none';
        updateTeamDisplay();
    }
}

function autoFill() {
    baseTeam = [];
    transfers = [];
    swapOverrides = [];
    const budget = 100;
    const formation = { GK: 2, DEF: 5, MID: 5, FWD: 3 };
    // Exclude players who have left the league
    const available = allPlayers.filter(p => p.status !== 'u');
    const byValue = (a, b) => (b.ppg / b.price) - (a.ppg / a.price);
    const playersByPosition = {
        GK: available.filter(p => p.position === 'GK').sort(byValue),
        DEF: available.filter(p => p.position === 'DEF').sort(byValue),
        MID: available.filter(p => p.position === 'MID').sort(byValue),
        FWD: available.filter(p => p.position === 'FWD').sort(byValue)
    };
    let remainingBudget = budget;
    const teamCounts = {};

    Object.entries(formation).forEach(([pos, count]) => {
        let added = 0;
        for (const player of playersByPosition[pos]) {
            if (added >= count) break;
            const teamCount = teamCounts[player.teamId] || 0;
            if (teamCount >= 3) continue;
            if (player.price > remainingBudget - (15 - baseTeam.length - 1) * 4) continue;
            baseTeam.push(player.id);
            teamCounts[player.teamId] = teamCount + 1;
            remainingBudget -= player.price;
            added++;
        }
    });

    userTeamData = null;
    userTeamPicks = null;
    initialBankBalance = 0;
    const teamInfoHeader = document.getElementById('teamInfoHeader');
    if (teamInfoHeader) teamInfoHeader.style.display = 'none';

    updateTeamDisplay();
    alert('Baseline team auto-filled! Transfers cleared.');
}

/* --- Swap logic & UI interactions --- */

function performSwapBetweenSlots(slotAEl, slotBEl) {
    if (!slotAEl || !slotBEl) return;

    const pidA = parseInt(slotAEl.dataset.playerId);
    const pidB = parseInt(slotBEl.dataset.playerId);

    const slotAType = slotAEl.dataset.slotType;
    const slotBType = slotBEl.dataset.slotType;

    const gw = viewedGW || upcomingGW || 1;

    // Remove any existing swap overrides for these players at this gameweek
    // This allows players to be swapped multiple times
    swapOverrides = swapOverrides.filter(s => 
        !((s.playerId === pidA || s.playerId === pidB) && s.gw === gw)
    );

    // Add new swap overrides
    if (pidA) {
        swapOverrides.push({ 
            gw: gw, 
            playerId: pidA, 
            preferredStart: (slotBType === 'starting') 
        });
    }
    if (pidB) {
        swapOverrides.push({ 
            gw: gw, 
            playerId: pidB, 
            preferredStart: (slotAType === 'starting') 
        });
    }

    selectedSlotEl = null;
    updateTeamDisplay();
}

/* --- UI rendering of team slots (GW-aware) --- */

function updateTeamDisplay() {
    const teamForView = (viewedGW !== null) ? computeTeamForGW(viewedGW) : [];

    if (selectedSlotEl && !document.body.contains(selectedSlotEl)) selectedSlotEl = null;

    document.querySelectorAll('.player-slot').forEach(slot => {
        const defaultText = slot.dataset.pos === 'ANY' ? 'SUB' : slot.dataset.pos;
        slot.innerHTML = `<div class="player-name">${defaultText}</div><div class="player-fixture"></div>`;
        slot.classList.remove('filled', 'difficulty-1','difficulty-2','difficulty-3','difficulty-4','difficulty-5','no-fixture','selected-slot');
        delete slot.dataset.playerId;
    });

    const formation = document.getElementById('formationSelect')?.value || '442';
    const formations = {
        '442': [4,4,2],
        '433': [4,3,3],
        '343': [3,4,3],
        '352': [3,5,2],
        '541': [5,4,1]
    };
    const [defStart, midStart, fwdStart] = formations[formation] || formations['442'];
    const startingSlotCounts = { GK: 1, DEF: defStart, MID: midStart, FWD: fwdStart };

    const positionSlots = {
        'GK': [0, 14],
        'DEF': [1,2,3,4,5],
        'MID': [6,7,8,9,10],
        'FWD': [11,12,13]
    };
    const benchSlots = [14,15,16,17];
    const usedSlotsCount = { GK: 0, DEF: 0, MID: 0, FWD: 0, ANY: 0 };

    const withPref = [];
    const withoutPref = [];
    teamForView.forEach(p => {
        const override = getLatestSwapOverride(p.id, viewedGW || upcomingGW || 1);
        if (override && override.preferredStart) withPref.push(p);
        else withoutPref.push(p);
    });
    const orderedPlayers = withPref.concat(withoutPref);

    function placePlayerInSlot(player, slotEl) {
        if (!slotEl) return;
        
        let fixtureInfoText = '';
        let difficultyClass = 'no-fixture';
        if (viewedGW !== null) {
            const fx = allFixtures.find(f => f.event === viewedGW && (f.team_h === player.teamId || f.team_a === player.teamId));
            if (fx) {
                const isHome = fx.team_h === player.teamId;
                const opponentId = isHome ? fx.team_a : fx.team_h;
                const opponent = allTeams.find(t => t.id === opponentId)?.short_name || 'TBD';
                const difficulty = isHome ? fx.team_h_difficulty : fx.team_a_difficulty;
                fixtureInfoText = `${isHome ? 'H' : 'A'} ${opponent}`;
                difficultyClass = `difficulty-${difficulty}`;
            } else {
                const nextFx = allFixtures.find(f => (f.team_h === player.teamId || f.team_a === player.teamId) && !f.finished);
                if (nextFx) {
                    const isHome = nextFx.team_h === player.teamId;
                    const opponentId = isHome ? nextFx.team_a : nextFx.team_h;
                    const opponent = allTeams.find(t => t.id === opponentId)?.short_name || 'TBD';
                    const difficulty = isHome ? nextFx.team_h_difficulty : nextFx.team_a_difficulty;
                    fixtureInfoText = `${isHome ? 'H' : 'A'} ${opponent}`;
                    difficultyClass = `difficulty-${difficulty}`;
                } else {
                    fixtureInfoText = 'No fixture';
                    difficultyClass = 'no-fixture';
                }
            }
        }

        const displayPrice = (userTeamData && baseTeam.includes(player.id)) ? 
            (player.sellPrice ?? player.price) : player.price;

        slotEl.innerHTML = `
            <div class="player-team-badge">
                <img src="${badgeSrc(player.team)}" 
                     alt="${player.team}" class="team-badge-img-small"
                     onerror="this.src='PLbadges/default.png'">
            </div>
            <div class="player-name">${player.name}</div>
            <div class="player-price">£${displayPrice.toFixed(1)}m</div>
            <div class="player-fixture">${fixtureInfoText}</div>
            <div class="remove-player" data-player-id="${player.id}">Remove</div>
        `;
        slotEl.classList.add('filled', difficultyClass);
        slotEl.dataset.playerId = player.id;
    }

    orderedPlayers.forEach(player => {
        const pos = player.position;
        const maxStartingForPos = startingSlotCounts[pos] || 0;
        
        if (usedSlotsCount[pos] < maxStartingForPos) {
            const slotIndex = positionSlots[pos][usedSlotsCount[pos]];
            const slotEl = document.querySelector(`[data-slot="${slotIndex}"]`);
            placePlayerInSlot(player, slotEl);
            usedSlotsCount[pos]++;
        } else {
            if (usedSlotsCount['ANY'] < benchSlots.length) {
                const benchIndex = benchSlots[usedSlotsCount['ANY']];
                const slotEl = document.querySelector(`[data-slot="${benchIndex}"]`);
                placePlayerInSlot(player, slotEl);
                usedSlotsCount['ANY']++;
            }
        }
    });

    document.querySelectorAll('.remove-player').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const pid = parseInt(btn.dataset.playerId);
            if (confirm('Remove this player from this GW onwards?')) {
                removeFromTeamForGW(pid, viewedGW);
            }
        });
    });

    document.querySelectorAll('.player-slot').forEach(slot => {
        if (selectedSlotEl && slot === selectedSlotEl) slot.classList.add('selected-slot');
        else slot.classList.remove('selected-slot');

        slot.onclick = function (e) {
            e.stopPropagation();
            if (selectedSlotEl === slot) {
                slot.classList.remove('selected-slot');
                selectedSlotEl = null;
                return;
            }
            if (!selectedSlotEl) {
                selectedSlotEl = slot;
                slot.classList.add('selected-slot');
                return;
            }
            performSwapBetweenSlots(selectedSlotEl, slot);
            document.querySelectorAll('.player-slot').forEach(s => s.classList.remove('selected-slot'));
            selectedSlotEl = null;
        };

        slot.oncontextmenu = function (e) {
            e.preventDefault();
            const pid = parseInt(slot.dataset.playerId);
            if (!pid) return;
            const player = allPlayers.find(p => p.id === pid);
            if (!player) return;
            const current = (player.customPrice ?? player.price).toFixed(1);
            const newPriceStr = prompt(`Enter new price for ${player.name} (current £${current}m):`, current);
            const newPrice = parseFloat(newPriceStr);
            if (!isNaN(newPrice) && newPrice > 0) {
                player.price = newPrice;
                player.customPrice = newPrice;
                if (baseTeam.includes(player.id)) player.sellPrice = newPrice;
                updateTeamDisplay();
            }
        };
    });

    const currentTeamValue = calculateCurrentTeamValue(teamForView);
    const availableBudget = calculateAvailableBudget(teamForView);

    const playerCountEl = document.getElementById('playerCount');
    const totalCostEl = document.getElementById('totalCost');
    const remainingEl = document.getElementById('remaining');

    if (playerCountEl) playerCountEl.textContent = `${teamForView.length}/15 Players`;
    if (totalCostEl) totalCostEl.textContent = `£${teamForView.reduce((sum, p) => sum + (p.price || 0), 0).toFixed(1)}m spent`;
    if (remainingEl) remainingEl.textContent = `£${availableBudget.toFixed(1)}m available`;
    
    const teamValueEl = document.getElementById('teamValue');
    if (teamValueEl) {
        if (userTeamData) {
            teamValueEl.textContent = `£${currentTeamValue.toFixed(1)}m team value`;
            teamValueEl.style.display = 'inline';
        } else {
            teamValueEl.style.display = 'none';
        }
    }

    changeFormation();
    updateGWDisplay();
}

function changeFormation() {
    const formationSelect = document.getElementById('formationSelect');
    if (!formationSelect) return;
    const formation = formationSelect.value || '442';
    const formations = {
        '442': [4,4,2],
        '433': [4,3,3],
        '343': [3,4,3],
        '352': [3,5,2],
        '541': [5,4,1]
    };
    const [def, mid, fwd] = formations[formation] || formations['442'];

    document.querySelectorAll('.defenders .player-slot').forEach((slot, index) => {
        slot.style.display = index < def ? 'flex' : 'none';
    });
    document.querySelectorAll('.midfielders .player-slot').forEach((slot, index) => {
        slot.style.display = index < mid ? 'flex' : 'none';
    });
    document.querySelectorAll('.forwards .player-slot').forEach((slot, index) => {
        slot.style.display = index < fwd ? 'flex' : 'none';
    });
}