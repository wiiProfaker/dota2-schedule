import './style.css'

const HAGLUND = 'https://red-sky-5edd.yarmolich-k.workers.dev/v1/matches'
const STEAM_PROXY = 'https://frosty-pine-692a.yarmolich-k.workers.dev'
const ODOTA   = 'https://api.opendota.com/api'
const HERO_IMG = 'https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/icons/'

// ── State ──────────────────────────────────────────────────────────────────
let allMatches = []
let heroesMap  = {}
let allTeams   = null
let proMatches = null
let currentFilter = 'all'
let openHash = null

// ── Utils ──────────────────────────────────────────────────────────────────
const norm     = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
const isTBD    = n => !n || n === 'TBD'
const isPast   = iso => new Date(iso) < new Date()
const fmtTime  = iso => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
const fmtDur   = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
const heroName = id => heroesMap[id]?.localized_name || '?'
const heroSlug = id => (heroesMap[id]?.name || '').replace('npc_dota_hero_', '')
const cleanName = n => (n || 'TBD').replace(/\s*\(page does not exist\)/g, '').trim()

function dayKey(iso) {
  const d = new Date(iso)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

function dayLabel(iso) {
  const d = new Date(iso), n = new Date()
  const today = new Date(n.getFullYear(), n.getMonth(), n.getDate())
  const diff  = new Date(d.getFullYear(), d.getMonth(), d.getDate()) - today
  if (diff ===  0)        return 'Сегодня'
  if (diff ===  86400000) return 'Завтра'
  if (diff === -86400000) return 'Вчера'
  if (diff < 0) return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })
  return d.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' })
}

function pl(n) {
  if (n % 10 === 1 && n % 100 !== 11) return ''
  if (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20)) return 'а'
  return 'ей'
}

// ── Data loaders ───────────────────────────────────────────────────────────
async function loadSchedule() {
  const r = await fetch(HAGLUND)
  if (!r.ok) throw new Error(`haglund.dev: ${r.status}`)
  const data = await r.json()
  allMatches = data
    .map(m => ({ ...m, teams: m.teams.map(t => ({ ...t, name: cleanName(t?.name) })) }))
    .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt))
}

async function ensureHeroes() {
  if (Object.keys(heroesMap).length) return
  const r = await fetch(`${ODOTA}/heroes`)
  if (!r.ok) throw new Error(`heroes: ${r.status}`);
  (await r.json()).forEach(h => { heroesMap[h.id] = h })
}

async function ensureTeams() {
  if (allTeams) return
  const r = await fetch(`${ODOTA}/teams`)
  if (!r.ok) throw new Error(`teams: ${r.status}`)
  allTeams = await r.json()
}

async function ensureProMatches() {
  if (proMatches) return
  const r = await fetch(`${ODOTA}/proMatches`)
  if (!r.ok) throw new Error(`proMatches: ${r.status}`)
  proMatches = await r.json()
}

function findTeam(name) {
  if (!allTeams) return null
  const q = norm(name)
  return allTeams.find(t => norm(t.name) === q || norm(t.tag) === q)
      || allTeams.find(t => norm(t.name).includes(q) || q.includes(norm(t.name)))
      || null
}

function findProMatch(t1, t2) {
  if (!proMatches) return null
  const n1 = norm(t1), n2 = norm(t2)
  return proMatches.find(m => {
    const rn = norm(m.radiant_name || ''), dn = norm(m.dire_name || '')
    return (rn.includes(n1) || n1.includes(rn)) && (dn.includes(n2) || n2.includes(dn))
        || (rn.includes(n2) || n2.includes(rn)) && (dn.includes(n1) || n1.includes(dn))
  }) || null
}

// ── Detail panel ───────────────────────────────────────────────────────────
async function loadDetail(hash) {
  const panel = document.getElementById('dp-' + hash)
  if (!panel || panel.dataset.loaded) return
  panel.dataset.loaded = '1'

  const match = allMatches.find(m => m.hash === hash)
  const t1 = match.teams[0]?.name
  const t2 = match.teams[1]?.name
  const past = isPast(match.startsAt)

  try {
    panel.innerHTML = '<div class="detail-msg">Загружаем данные...</div>'
    await ensureHeroes()

    if (past && !isTBD(t1) && !isTBD(t2)) {
      await ensureProMatches()
      const found = findProMatch(t1, t2)
      if (found) {
        panel.innerHTML = '<div class="detail-msg">Загружаем статистику матча...</div>'
        const r = await fetch(`${ODOTA}/matches/${found.match_id}`)
        const md = await r.json()
        renderMatchStats(panel, md, t1, t2)
        return
      }
    }

    // Ростеры
    const sides = [t1, t2].filter(n => !isTBD(n))
    if (!sides.length) {
      panel.innerHTML = '<div class="detail-msg">Команды ещё не определены (TBD)</div>'
      return
    }

    const note = past
      ? 'Матч не найден в последних данных OpenDota. Текущие ростеры:'
      : 'Матч ещё не сыгран. Текущие ростеры:'
    panel.innerHTML = `<div class="detail-note">${note}</div><div class="players-grid" id="rg-${hash}"><div class="detail-msg">Ищем команды...</div></div>`

    await ensureTeams()
    const grid = document.getElementById('rg-' + hash)

    const rosters = await Promise.all(sides.map(async name => {
      const team = findTeam(name)
      if (!team) return { name, players: [] }
      const pr = await fetch(`${ODOTA}/teams/${team.team_id}/players`)
      const players = (await pr.json()).filter(p => p.is_current_team_member)
      return { name, team, players }
    }))

    if (rosters.every(r => !r.players.length)) {
      grid.innerHTML = `<div class="detail-msg err" style="grid-column:1/-1">Команды не найдены в OpenDota.</div>`
      return
    }

    grid.innerHTML = rosters.map(r => `
      <div>
        <div class="team-block-title">${r.name}${r.team ? ` · ${r.team.wins}W ${r.team.losses}L` : ''}</div>
        ${r.players.length
          ? r.players.slice(0, 5).map(p => `
            <div class="roster-row">
              <img class="roster-avatar" src="${p.avatarfull || ''}" onerror="this.style.opacity=0" />
              <div>
                <div class="roster-name">${p.name || p.personaname || '—'}</div>
                <div class="roster-nick">${p.name && p.personaname && p.name !== p.personaname ? p.personaname : ''}</div>
              </div>
            </div>`).join('')
          : '<div class="detail-msg">Ростер не найден</div>'
        }
      </div>`).join('')

  } catch(e) {
    if (panel) {
      panel.innerHTML = `<div class="detail-msg err">Ошибка: ${e.message}</div>`
      panel.dataset.loaded = ''
    }
  }
}

function renderMatchStats(panel, md, t1name, t2name) {
  const rw = md.radiant_win
  const rP = md.players.filter(p => p.player_slot < 128)
  const dP = md.players.filter(p => p.player_slot >= 128)
  const rScore = md.radiant_score ?? rP.reduce((s, p) => s + p.kills, 0)
  const dScore = md.dire_score   ?? dP.reduce((s, p) => s + p.kills, 0)
  const rName = md.radiant_team?.name || t1name
  const t1isRad = norm(rName).includes(norm(t1name)) || norm(t1name).includes(norm(rName))
  const t1win   = t1isRad ? rw : !rw
  const t1score = t1isRad ? rScore : dScore
  const t2score = t1isRad ? dScore : rScore
  const t1p = t1isRad ? rP : dP
  const t2p = t1isRad ? dP : rP

  const pRows = players => players.map(p => {
    const slug = heroSlug(p.hero_id)
    const kda  = p.deaths > 0 ? ((p.kills + p.assists) / p.deaths).toFixed(1) : '∞'
    return `<div class="player-row">
      <img class="hero-icon" src="${HERO_IMG}${slug}.png" onerror="this.style.opacity=0.1" />
      <div class="player-info">
        <div class="player-name">${p.name || p.personaname || '—'}</div>
        <div class="player-hero">${heroName(p.hero_id)}</div>
      </div>
      <div class="player-stats">
        <div class="player-kda">${p.kills}/${p.deaths}/${p.assists}</div>
        <div class="player-gpm">${p.gold_per_min || 0} gpm</div>
      </div>
    </div>`
  }).join('')

  panel.innerHTML = `
    <div class="score-banner">
      <div class="score-team${t1win ? ' winner' : ''}">${t1name}</div>
      <div class="score-nums">
        <div class="score-n ${t1win ? 'win' : 'loss'}">${t1score}</div>
        <div class="score-colon">:</div>
        <div class="score-n ${!t1win ? 'win' : 'loss'}">${t2score}</div>
      </div>
      <div class="score-team${!t1win ? ' winner' : ''}">${t2name}</div>
    </div>
    <div class="players-grid">
      <div><div class="team-block-title">${t1name}</div>${pRows(t1p)}</div>
      <div><div class="team-block-title">${t2name}</div>${pRows(t2p)}</div>
    </div>
    <div class="match-extra">
      <div class="extra-box"><div class="extra-label">Длительность</div><div class="extra-val">${fmtDur(md.duration)}</div></div>
      <div class="extra-box"><div class="extra-label">First blood</div><div class="extra-val">${fmtDur(md.first_blood_time || 0)}</div></div>
      <div class="extra-box"><div class="extra-label">Match ID</div><div class="extra-val" style="font-size:0.7rem">${md.match_id}</div></div>
    </div>`
}

// ── Toggle detail ──────────────────────────────────────────────────────────
function toggleDetail(hash) {
  const panel  = document.getElementById('dp-' + hash)
  const row    = document.getElementById('row-' + hash)
  const chevron = row?.querySelector('.chevron')
  const isOpen = panel?.classList.contains('open')

  document.querySelectorAll('.detail-panel.open').forEach(p => p.classList.remove('open'))
  document.querySelectorAll('.match-row.open').forEach(r => r.classList.remove('open'))
  document.querySelectorAll('.chevron.open').forEach(c => c.classList.remove('open'))

  if (!isOpen) {
    panel?.classList.add('open')
    row?.classList.add('open')
    chevron?.classList.add('open')
    openHash = hash
    loadDetail(hash)
  } else {
    openHash = null
  }
}

// ── Render ─────────────────────────────────────────────────────────────────
// ── Live matches ───────────────────────────────────────────────────────────
let liveGames = []

async function loadLiveGames() {
  try {
    const r = await fetch(`${STEAM_PROXY}/live`)
    const d = await r.json()
    liveGames = d?.result?.games || []
  } catch(e) {
    liveGames = []
  }
}

function findLiveGame(t1, t2) {
  if (!t1 || !t2) return null
  const n = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  const n1 = n(t1), n2 = n(t2)
  return liveGames.find(g => {
    const rn = n(g.radiant_team?.team_name || '')
    const dn = n(g.dire_team?.team_name || '')
    return (rn.includes(n1) || n1.includes(rn)) && (dn.includes(n2) || n2.includes(dn))
        || (rn.includes(n2) || n2.includes(rn)) && (dn.includes(n1) || n1.includes(dn))
  }) || null
}
function render() {
  const query = document.getElementById('searchInput').value.trim().toLowerCase()
  let matches = allMatches
  if (currentFilter === 'upcoming') matches = matches.filter(m => !isPast(m.startsAt))
  if (currentFilter === 'past')     matches = matches.filter(m =>  isPast(m.startsAt))
  if (query) matches = matches.filter(m =>
    m.teams.some(t => (t?.name || '').toLowerCase().includes(query)) ||
    m.leagueName.toLowerCase().includes(query)
  )

  const list = document.getElementById('matchList')
  if (!matches.length) {
    list.innerHTML = '<div class="empty-state">Матчи не найдены</div>'
    return
  }

  const groups = {}
  matches.forEach(m => {
    const k = dayKey(m.startsAt)
    if (!groups[k]) groups[k] = { label: dayLabel(m.startsAt), items: [] }
    groups[k].items.push(m)
  })

  list.innerHTML = Object.values(groups).map(g => `
    <div class="day-group">
      <div class="day-label">${g.label} — ${g.items.length} матч${pl(g.items.length)}</div>
      ${g.items.map(m => {
        const t1   = m.teams[0]?.name || 'TBD'
        const t2   = m.teams[1]?.name || 'TBD'
        const past = isPast(m.startsAt)
        const live = !past && findLiveGame(t1, t2)
        const liq  = m.leagueUrl
          ? `<a class="lp-link" href="${m.leagueUrl}" target="_blank" rel="noopener">LP ↗</a>`
          : ''
        return `
          <div class="match-item">
            <div class="match-row" id="row-${m.hash}" onclick="window.__toggleDetail('${m.hash}')">
              <div class="match-time">${fmtTime(m.startsAt)}</div>
              <div class="match-teams">
                <span class="team${isTBD(t1) ? ' tbd' : ''}">${t1}</span>
                <span class="vs">vs</span>
                <span class="team${isTBD(t2) ? ' tbd' : ''}">${t2}</span>
              </div>
              <div class="match-right">
                <div class="league">${m.leagueName}</div>
                <div class="badges">
                  <span class="badge badge-bo">${m.matchType}</span>
                  <span class="badge ${past ? 'badge-past' : live ? 'badge-live' : 'badge-future'}">${past ? 'завершён' : live ? '● live' : 'скоро'}</span>
                  ${liq}
                </div>
              </div>
              <span class="chevron">▾</span>
            </div>
            <div class="detail-panel" id="dp-${m.hash}"></div>
          </div>`
      }).join('')}
    </div>`).join('')
}

// expose to HTML onclick
window.__toggleDetail = toggleDetail

// ── Controls ───────────────────────────────────────────────────────────────
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    currentFilter = btn.dataset.filter
    openHash = null
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    render()
  })
})

document.getElementById('searchInput').addEventListener('input', render)

// ── Init ───────────────────────────────────────────────────────────────────
;(async () => {
  try {
    await Promise.all([loadSchedule(), loadLiveGames()])
    const now = Date.now()
    document.getElementById('cntAll').textContent      = allMatches.length
    document.getElementById('cntUpcoming').textContent = allMatches.filter(m => new Date(m.startsAt) > now).length
    document.getElementById('cntPast').textContent     = allMatches.filter(m => new Date(m.startsAt) <= now).length
    document.getElementById('cntLeagues').textContent  = new Set(allMatches.map(m => m.leagueName)).size
    document.getElementById('headerMeta').textContent  = `Обновлено: ${new Date().toLocaleTimeString('ru-RU')}`
setInterval(async () => {
  await loadLiveGames()
  render()
}, 30000)
    render()
  } catch(e) {
    document.getElementById('matchList').innerHTML =
      `<div class="empty-state" style="color:#f87171">Ошибка загрузки: ${e.message}</div>`
  }
})()
