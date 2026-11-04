import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import {
  apiLogin,
  apiGetStatus,
  apiCheckIn,
  apiCheckOut,
  getSavedToken,
  deleteToken,
} from './api.js';
import { CONFIG } from './config.js';
import {
  initNotifications,
  evaluateReminders,
  getStreak,
  recordCheckInForStreak,
} from './reminders.js';

const isTauri = typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__ || window.__TAURI__);

// Random message pools (>= 5 variants each, friendly and concise)
const MESSAGES = {
  sleepNormal: [
    'Sleeping soundly. Click below to wake me up!',
    'Zzz... Good morning! Ready when you are.',
    'I am all curled up. Time to start the day?',
    'All quiet here. Tap below to clock in!',
    'Still in dreamland. Ready to get things done?',
  ],
  sleepLate: [
    'Hmph, cutting it close today! Let us check in.',
    'A bit behind schedule, friend. Wake me up!',
    'Better late than never! Let us get to it.',
    'Clock is ticking! Time to start the shift.',
    'Almost lunchtime! Let us get you on the board.',
  ],
  afterCheckOut: [
    'Checked out. See you tomorrow!',
    'Great work today! Enjoy your evening.',
    'All wrapped up! Time to kick back and relax.',
    'Shift completed. Have a wonderful rest of your day!',
    'Logged off and resting. Catch you next time!',
  ],
  awakeNormal: [
    'Wide awake and ready! Have a productive day.',
    'Tracking your progress. You have got this!',
    'Clocked in and rolling! Looking good today.',
    'In the zone! Working steadily.',
    'Everything is running smoothly. Happy work hours!',
    'Remember to take a sip of water! 💧',
    'Stretch your arms overhead and relax your shoulders! 🙆',
    'Sit up straight, roll your neck, and take a deep breath. ✨',
  ],
  awakeLate: [
    'Long day! Maybe time to check out?',
    'The stars are out. Do not forget to clock out!',
    'Great shift today. Ready to call it a day?',
    'Time to rest your eyes. Let us check out!',
    'Work will be here tomorrow. Time to head out!',
  ],
  friday: [
    'Happy Friday! Almost the weekend!',
    'Friday vibes! Let us finish the week strong.',
  ],
  silly: [
    'Boing! Hey, that tickles!',
    'Wheee! Do not poke the mascot!',
    'Jiggle jiggle! I am the softest attendance clock.',
    'Bounce! Ready to conquer the workday!',
    'Wobble wobble! Keep up the great energy.',
  ],
};

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function formatDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(date);
}

const state = {
  view: 'loading',
  token: null,
  checkedIn: false,
  shiftDone: false,
  checkInTime: null,
  checkOutTime: null,
  workingHours: null,
  isLate: false,
  isOvertime: false,
  isLoadingAction: false,
  actionLoadingText: '',
  bubbleText: '',
  loginError: null,
  streak: 0,
};

const appWindow = isTauri ? getCurrentWebviewWindow() : null;
const cardEl = document.getElementById('card');

function updateContextualMessage(override = null) {
  if (override) {
    state.bubbleText = override;
    return;
  }

  if (state.shiftDone) {
    state.isLate = false;
    state.isOvertime = false;
    state.bubbleText = pickRandom(MESSAGES.afterCheckOut);
    return;
  }

  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const cfg = CONFIG.REMINDERS || {};
  const checkInDeadline = (cfg.checkInByHour ?? 10) * 60 + (cfg.checkInByMinute ?? 0);
  const checkOutDeadline = (cfg.checkOutAfterHour ?? 19) * 60 + (cfg.checkOutAfterMinute ?? 0);

  state.isLate = !state.checkedIn && currentMinutes > checkInDeadline;
  state.isOvertime = state.checkedIn && currentMinutes >= checkOutDeadline;

  if (now.getDay() === 5 && state.checkedIn) {
    state.bubbleText = pickRandom(MESSAGES.friday);
    return;
  }

  if (state.checkedIn) {
    state.bubbleText = state.isOvertime
      ? pickRandom(MESSAGES.awakeLate)
      : pickRandom(MESSAGES.awakeNormal);
  } else {
    state.bubbleText = state.isLate
      ? pickRandom(MESSAGES.sleepLate)
      : pickRandom(MESSAGES.sleepNormal);
  }
}

function getWorkedTime() {
  if (state.shiftDone) {
    if (typeof state.workingHours === 'number') {
      const totalMinutes = Math.round(state.workingHours * 60);
      const hours = Math.floor(totalMinutes / 60);
      const minutes = totalMinutes % 60;
      return {
        timeStr: `${hours}h ${String(minutes).padStart(2, '0')}m`,
        labelStr: "today's shift is done",
      };
    }
    if (state.checkInTime && state.checkOutTime) {
      const diffMs = Math.max(0, new Date(state.checkOutTime) - new Date(state.checkInTime));
      const totalMinutes = Math.floor(diffMs / (1000 * 60));
      const hours = Math.floor(totalMinutes / 60);
      const minutes = totalMinutes % 60;
      return {
        timeStr: `${hours}h ${String(minutes).padStart(2, '0')}m`,
        labelStr: "today's shift is done",
      };
    }
    return {
      timeStr: '0h 00m',
      labelStr: "today's shift is done",
    };
  }

  if (!state.checkedIn || !state.checkInTime) {
    return { timeStr: '--h --m', labelStr: 'not checked in' };
  }

  const checkInDate = new Date(state.checkInTime);
  const diffMs = Math.max(0, Date.now() - checkInDate.getTime());
  const totalMinutes = Math.floor(diffMs / (1000 * 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  return {
    timeStr: `${hours}h ${String(minutes).padStart(2, '0')}m`,
    labelStr: 'worked today',
  };
}

async function syncTray() {
  if (!isTauri) return;
  try {
    await invoke('set_tray_state', { checkedIn: state.checkedIn });
  } catch (err) {
    console.warn('Tray update skipped:', err);
  }
}

function renderMascotSvg() {
  const isAwake = state.checkedIn;
  const isLate = state.isLate;
  const isOvertime = state.isOvertime;
  const isShiftDone = state.shiftDone;

  let workedHours = 0;
  if (state.checkedIn && state.checkInTime) {
    const diffMs = Math.max(0, Date.now() - new Date(state.checkInTime).getTime());
    workedHours = diffMs / (1000 * 60 * 60);
  } else if (typeof state.workingHours === 'number') {
    workedHours = state.workingHours;
  }

  // Blob color changes:
  // Daytime working: bright butter yellow (#FFD84D)
  // Overtime working: sunset warm peach (#FFA07A)
  // Night / Resting / Shift complete: soothing lavender (#B9A7FF)
  let blobFill = '#B9A7FF';
  if (isAwake) {
    blobFill = (workedHours >= 8 || isOvertime) ? '#FFBA7A' : '#FFD84D';
  }

  let faceContent = '';

  if (isShiftDone) {
    // 1. Shift Completed: Peaceful, happy curved eyes (^ ^) with satisfied smile
    faceContent = `
      <path d="M38 52 Q44 44 50 52" fill="none" stroke="#2B2140" stroke-width="3.5" stroke-linecap="round" />
      <path d="M70 52 Q76 44 82 52" fill="none" stroke="#2B2140" stroke-width="3.5" stroke-linecap="round" />
      <path d="M54 63 Q60 68 66 63" fill="none" stroke="#2B2140" stroke-width="3" stroke-linecap="round" />
      <g class="floating-zs">
        <text x="82" y="38" class="zzz z1">z</text>
        <text x="92" y="24" class="zzz z2">z</text>
        <text x="100" y="12" class="zzz z3">Z</text>
      </g>
    `;
  } else if (isAwake) {
    // Expressions as the workday progresses:
    if (workedHours >= 8 || isOvertime) {
      // 2a. Overtime / 8+ hours: Exhausted (> <) eyes, sweat drop, pleading to clock out
      faceContent = `
        <path d="M37 47 L48 52 L37 57" fill="none" stroke="#2B2140" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" />
        <path d="M83 47 L72 52 L83 57" fill="none" stroke="#2B2140" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" />
        <ellipse cx="60" cy="65" rx="5" ry="6" fill="#2B2140" />
        <path d="M57 67 Q60 70 63 67" fill="#FF8A7A" />
        <path d="M88 28 C88 28 92 33 92 36 C92 38.5 90 40 88 40 C86 40 84 38.5 84 36 C84 33 88 28 88 28 Z" fill="#60A5FA" />
      `;
    } else if (workedHours >= 5.5) {
      // 2b. Late Afternoon (5.5 - 8 hrs): Droopy half-closed eyelids, tiny sweat drop, working towards clock-out
      faceContent = `
        <circle cx="44" cy="51" r="5.5" fill="#2B2140" class="clocky-eye" />
        <circle cx="43" cy="51" r="1.8" fill="#FFFFFF" class="clocky-pupil" />
        <path d="M37 46 Q44 49 51 46" fill="none" stroke="#2B2140" stroke-width="3" stroke-linecap="round" />
        <circle cx="76" cy="51" r="5.5" fill="#2B2140" class="clocky-eye" />
        <circle cx="75" cy="51" r="1.8" fill="#FFFFFF" class="clocky-pupil" />
        <path d="M69 46 Q76 49 83 46" fill="none" stroke="#2B2140" stroke-width="3" stroke-linecap="round" />
        <path d="M53 65 Q57 63 61 65 Q65 67 67 65" fill="none" stroke="#2B2140" stroke-width="3" stroke-linecap="round" />
        <path d="M85 32 C85 32 88 36 88 38 C88 40 86.5 41.5 85 41.5 C83.5 41.5 82 40 82 38 C82 36 85 32 85 32 Z" fill="#60A5FA" />
      `;
    } else if (workedHours >= 2.5) {
      // 2c. Midday / Productive (2.5 - 5.5 hrs): Steady, focused, cheerful round eyes
      faceContent = `
        <circle cx="44" cy="50" r="5.5" fill="#2B2140" class="clocky-eye" />
        <circle cx="42.5" cy="48" r="2" fill="#FFFFFF" class="clocky-pupil" />
        <circle cx="76" cy="50" r="5.5" fill="#2B2140" class="clocky-eye" />
        <circle cx="74.5" cy="48" r="2" fill="#FFFFFF" class="clocky-pupil" />
        <path d="M52 64 Q60 72 68 64" fill="none" stroke="#2B2140" stroke-width="3.5" stroke-linecap="round" />
      `;
    } else {
      // 2d. Fresh Morning (0 - 2.5 hrs): Sparkly big eyes with double highlights & wide joyful smile
      faceContent = `
        <circle cx="44" cy="50" r="6" fill="#2B2140" class="clocky-eye" />
        <circle cx="42" cy="48" r="2.2" fill="#FFFFFF" class="clocky-pupil" />
        <circle cx="46.5" cy="51.5" r="1.1" fill="#FFFFFF" />
        <circle cx="76" cy="50" r="6" fill="#2B2140" class="clocky-eye" />
        <circle cx="74" cy="48" r="2.2" fill="#FFFFFF" class="clocky-pupil" />
        <circle cx="78.5" cy="51.5" r="1.1" fill="#FFFFFF" />
        <path d="M50 63 Q60 74 70 63" fill="#2B2140" stroke="#2B2140" stroke-width="2" stroke-linecap="round" />
        <path d="M53 65 Q60 72 67 65" fill="#FF8A7A" />
      `;
    }
  } else if (isLate) {
    // 3. Not clocked in & past 10 AM: Worried / guilty sleep face with furrowed brows
    faceContent = `
      <path d="M37 45 L48 48" stroke="#2B2140" stroke-width="3" stroke-linecap="round" />
      <path d="M83 45 L72 48" stroke="#2B2140" stroke-width="3" stroke-linecap="round" />
      <path d="M38 53 Q44 49 50 53" fill="none" stroke="#2B2140" stroke-width="3" stroke-linecap="round" />
      <path d="M70 53 Q76 49 82 53" fill="none" stroke="#2B2140" stroke-width="3" stroke-linecap="round" />
      <path d="M55 67 Q60 63 65 67" fill="none" stroke="#2B2140" stroke-width="3" stroke-linecap="round" />
      <g class="floating-zs">
        <text x="82" y="38" class="zzz z1">z</text>
        <text x="92" y="24" class="zzz z2">z</text>
        <text x="100" y="12" class="zzz z3">Z</text>
      </g>
    `;
  } else {
    // 4. Not clocked in & morning (before 10 AM): Peaceful sleep with little round mouth
    faceContent = `
      <path d="M38 52 Q44 45 50 52" fill="none" stroke="#2B2140" stroke-width="3.5" stroke-linecap="round" />
      <path d="M70 52 Q76 45 82 52" fill="none" stroke="#2B2140" stroke-width="3.5" stroke-linecap="round" />
      <ellipse cx="60" cy="65" rx="3.5" ry="4.5" fill="#2B2140" />
      <g class="floating-zs">
        <text x="82" y="38" class="zzz z1">z</text>
        <text x="92" y="24" class="zzz z2">z</text>
        <text x="100" y="12" class="zzz z3">Z</text>
      </g>
    `;
  }

  return `
    <svg class="clocky-svg" viewBox="0 0 120 110" aria-label="Clocky attendance mascot" role="img">
      <ellipse cx="60" cy="103" rx="38" ry="4.5" fill="#2B2140" opacity="0.15" />
      <g class="clocky-blob">
        <path
          d="M60 8c28 0 50 20 50 50 0 26-20 42-50 42S10 84 10 58C10 28 32 8 60 8z"
          fill="${blobFill}"
          stroke="#2B2140"
          stroke-width="4"
          stroke-linejoin="round"
        />
        <circle cx="33" cy="64" r="7" fill="#FF8A7A" opacity="0.55" />
        <circle cx="87" cy="64" r="7" fill="#FF8A7A" opacity="0.55" />
        ${faceContent}
      </g>
    </svg>
  `;
}

function render() {
  if (state.checkedIn) {
    cardEl.classList.add('awake');
  } else {
    cardEl.classList.remove('awake');
  }

  const dateStr = formatDate();

  if (state.view === 'loading') {
    cardEl.innerHTML = `
      <div class="header-row" data-tauri-drag-region>
        <span class="header-date">${dateStr}</span>
        <button id="closeBtn" class="header-close-btn" data-tauri-drag-region="false" aria-label="Hide widget">x</button>
      </div>
      <div class="bubble-container">
        <div class="speech-bubble" aria-live="polite">Waking up Clocky...</div>
        <div class="bubble-tail"></div>
      </div>
      <div class="mascot-area">
        ${renderMascotSvg()}
      </div>
      <div class="time-area">
        <div class="time-value">--h --m</div>
        <div class="time-label">loading status...</div>
      </div>
      <div class="action-btn-area">
        <button class="squishy-btn check-in" disabled>Loading status...</button>
      </div>
    `;
    wireBaseButtons();
    return;
  }

  if (state.view === 'login') {
    cardEl.innerHTML = `
      <div class="header-row" data-tauri-drag-region>
        <span class="header-date">${dateStr}</span>
        <button id="closeBtn" class="header-close-btn" data-tauri-drag-region="false" aria-label="Hide widget">x</button>
      </div>
      <div class="bubble-container">
        <div class="speech-bubble" aria-live="polite">Log in to wake me up</div>
        <div class="bubble-tail"></div>
      </div>
      <div class="mascot-area" id="mascotWrapper">
        ${renderMascotSvg()}
      </div>
      <div class="login-view">
        ${state.loginError ? `<div class="login-error">${state.loginError}</div>` : ''}
        <form id="loginForm" class="login-form">
          <input
            id="usernameInput"
            class="login-input"
            type="text"
            placeholder="Username or email"
            required
            autocomplete="username"
            ${state.isLoadingAction ? 'disabled' : ''}
          />
          <input
            id="passwordInput"
            class="login-input"
            type="password"
            placeholder="Password"
            required
            autocomplete="current-password"
            ${state.isLoadingAction ? 'disabled' : ''}
          />
          <button
            type="submit"
            class="squishy-btn check-in"
            ${state.isLoadingAction ? 'disabled' : ''}
          >
            ${state.isLoadingAction ? 'Logging in...' : 'Wake me up'}
          </button>
        </form>
      </div>
    `;
    wireBaseButtons();
    wireLoginForm();
    return;
  }

  const { timeStr, labelStr } = getWorkedTime();
  const streakDays = state.streak;

  let actionAreaHtml = '';
  if (state.shiftDone) {
    // Day end: remove buttons on day end!
    actionAreaHtml = `
      <div class="day-completed-badge" title="Shift completed for today">
        Day Complete &bull; Shift Ended
      </div>
    `;
  } else if (state.checkedIn) {
    // Clocked in: show Clock Out button
    const btnText = state.isLoadingAction
      ? (state.actionLoadingText || 'Clocking Out...')
      : 'Clock Out';
    actionAreaHtml = `
      <button
        id="actionBtn"
        class="squishy-btn check-out"
        ${state.isLoadingAction ? 'disabled' : ''}
      >
        ${btnText}
      </button>
    `;
  } else {
    // Not clocked in: show Clock In button
    const btnText = state.isLoadingAction
      ? (state.actionLoadingText || 'Clocking In...')
      : 'Clock In';
    actionAreaHtml = `
      <button
        id="actionBtn"
        class="squishy-btn check-in"
        ${state.isLoadingAction ? 'disabled' : ''}
      >
        ${btnText}
      </button>
    `;
  }

  cardEl.innerHTML = `
    <div class="header-row" data-tauri-drag-region>
      <span class="header-date">${dateStr}</span>
      <button id="closeBtn" class="header-close-btn" data-tauri-drag-region="false" aria-label="Hide widget">x</button>
    </div>
    <div class="bubble-container">
      <div class="speech-bubble" id="speechBubble" aria-live="polite">${state.bubbleText}</div>
      <div class="bubble-tail"></div>
    </div>
    <div class="mascot-area" id="mascotWrapper">
      ${renderMascotSvg()}
    </div>
    <div class="time-area">
      <div class="time-value">${timeStr}</div>
      <div class="time-label">${labelStr}</div>
      ${streakDays > 0 ? `<div class="streak-line">${streakDays} day${streakDays === 1 ? '' : 's'} on time</div>` : ''}
    </div>
    <div class="action-btn-area">
      ${actionAreaHtml}
    </div>
  `;

  wireBaseButtons();
  wireMainActions();
}

function wireBaseButtons() {
  const closeBtn = document.getElementById('closeBtn');
  if (closeBtn) {
    closeBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (isTauri && appWindow) {
        try {
          await appWindow.hide();
        } catch (err) {
          console.warn('Could not hide window:', err);
        }
      } else {
        console.log('[Dev Mode] Widget hidden to tray (click reload to show)');
        cardEl.style.opacity = '0.3';
        setTimeout(() => { cardEl.style.opacity = '1'; }, 1000);
      }
    });
  }
}

function wireLoginForm() {
  const form = document.getElementById('loginForm');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (state.isLoadingAction) return;

    const username = document.getElementById('usernameInput')?.value?.trim();
    const password = document.getElementById('passwordInput')?.value;

    state.isLoadingAction = true;
    state.loginError = null;
    render();

    try {
      const token = await apiLogin(username, password);
      state.token = token;
      state.view = 'loading';
      render();
      await fetchStatusAndRender();
    } catch (err) {
      console.warn('Login failure:', err);
      state.loginError = err.message || 'Unable to log in. Please check your credentials.';
      render();
    } finally {
      state.isLoadingAction = false;
      render();
    }
  });
}

function wireMainActions() {
  const mascot = document.getElementById('mascotWrapper');
  if (mascot) {
    mascot.addEventListener('click', () => {
      const svg = mascot.querySelector('.clocky-svg');
      if (svg) {
        svg.classList.remove('clocky-wiggle');
        void svg.offsetWidth;
        svg.classList.add('clocky-wiggle');
      }
      state.bubbleText = pickRandom(MESSAGES.silly);
      const bubble = document.getElementById('speechBubble');
      if (bubble) bubble.textContent = state.bubbleText;
    });
  }

  const actionBtn = document.getElementById('actionBtn');
  if (actionBtn) {
    actionBtn.addEventListener('click', () => {
      handleAttendanceAction();
    });
  }
}

async function handleAttendanceAction() {
  if (state.isLoadingAction || state.shiftDone) return;

  state.isLoadingAction = true;
  state.actionLoadingText = state.checkedIn ? 'Clocking Out...' : 'Clocking In...';
  render();

  try {
    if (state.checkedIn) {
      state.actionLoadingText = 'Clocking Out...';
      render();
      const result = await apiCheckOut(state.token);
      state.checkedIn = !!result.checkedIn;
      state.shiftDone = !!result.shiftDone || true;
      state.checkInTime = result.checkInTime;
      state.checkOutTime = result.checkOutTime;
      state.workingHours = result.workingHours;
      state.bubbleText = pickRandom(MESSAGES.afterCheckOut);
    } else {
      state.actionLoadingText = 'Clocking In...';
      render();
      const result = await apiCheckIn(state.token);
      state.checkedIn = !!result.checkedIn;
      state.shiftDone = !!result.shiftDone;
      state.checkInTime = result.checkInTime;
      state.checkOutTime = result.checkOutTime;
      state.workingHours = result.workingHours;
      state.streak = recordCheckInForStreak(state.checkInTime);
      updateContextualMessage();
    }
    await syncTray();
    await evaluateReminders(state);
  } catch (err) {
    console.error('Attendance action failed:', err);
    if (err.status === 401) {
      state.token = null;
      state.view = 'login';
      state.loginError = 'Session expired. Please log in again.';
    } else {
      state.bubbleText = err.message || 'Operation failed. Please try again.';
    }
  } finally {
    state.isLoadingAction = false;
    state.actionLoadingText = '';
    render();
  }
}

async function fetchStatusAndRender() {
  if (!state.token) {
    state.view = 'login';
    render();
    return;
  }

  try {
    const status = await apiGetStatus(state.token);
    state.checkedIn = !!status.checkedIn;
    state.shiftDone = !!status.shiftDone;
    state.checkInTime = status.checkInTime;
    state.checkOutTime = status.checkOutTime;
    state.workingHours = status.workingHours;
    state.view = 'main';
    state.streak = getStreak();
    updateContextualMessage();
    await syncTray();
    await evaluateReminders(state);
  } catch (err) {
    console.warn('Status check failed:', err);
    if (err.status === 401) {
      state.token = null;
      state.view = 'login';
      state.loginError = 'Session expired. Please log in again.';
    } else if (state.view !== 'main') {
      state.view = 'main';
      state.bubbleText = 'Cannot reach server. Showing offline state.';
    }
  } finally {
    state.isLoadingAction = false;
    render();
  }
}

async function initApp() {
  // Render loading card immediately on script load so window is never blank
  render();

  initNotifications().catch(console.warn);

  if (isTauri) {
    try {
      await listen('tray-check-toggle', () => {
        handleAttendanceAction();
      });
      await listen('tray-logout', async () => {
        await deleteToken();
        state.token = null;
        state.checkedIn = false;
        state.checkInTime = null;
        state.view = 'login';
        state.loginError = null;
        await syncTray();
        render();
      });
    } catch (err) {
      console.warn('Tray listener setup skipped:', err);
    }
  }

  const savedToken = await getSavedToken();
  if (savedToken) {
    state.token = savedToken;
    await fetchStatusAndRender();
  } else {
    state.view = 'login';
    render();
  }

  let activeCalendarDay = formatDate();

  setInterval(async () => {
    const currentDay = formatDate();
    // Midnight rollover (12:00 AM): calendar day changed!
    if (currentDay !== activeCalendarDay) {
      activeCalendarDay = currentDay;
      state.shiftDone = false;
      state.checkedIn = false;
      state.checkInTime = null;
      state.checkOutTime = null;
      state.workingHours = null;
      if (state.token && !state.isLoadingAction) {
        await fetchStatusAndRender();
      } else {
        render();
      }
      return;
    }

    if (state.view === 'main') {
      const timeValEl = cardEl.querySelector('.time-value');
      const timeLblEl = cardEl.querySelector('.time-label');
      if (timeValEl && timeLblEl) {
        const { timeStr, labelStr } = getWorkedTime();
        timeValEl.textContent = timeStr;
        timeLblEl.textContent = labelStr;
      }
      const mascotWrapper = document.getElementById('mascotWrapper');
      if (mascotWrapper) {
        mascotWrapper.innerHTML = renderMascotSvg();
      }
    }
  }, 30000);

  setInterval(async () => {
    if (state.view === 'main') {
      await evaluateReminders(state);
    }
  }, 60000);

  setInterval(async () => {
    if (state.token && !state.isLoadingAction) {
      await fetchStatusAndRender();
    }
  }, 5 * 60 * 1000);

  window.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') {
      if (isTauri && appWindow) {
        await appWindow.hide();
      }
    }
  });

  window.addEventListener('focus', async () => {
    if (state.token && !state.isLoadingAction) {
      await fetchStatusAndRender();
    }
  });

  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && state.token && !state.isLoadingAction) {
      await fetchStatusAndRender();
    }
  });
}

initApp().catch((err) => {
  console.error('Fatal initialization error:', err);
  state.view = 'login';
  state.loginError = 'Initialization failed: ' + err.message;
  render();
});
