import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { CONFIG } from "./config.js";

const isTauri =
  typeof window !== "undefined" &&
  Boolean(window.__TAURI_INTERNALS__ || window.__TAURI__);

let lastCheckInNag = 0;
let lastCheckOutNag = 0;
let lastWellnessNudge = 0;
let wellnessIndex = 0;
let notificationPermissionReady = false;

export async function initNotifications() {
  if (!isTauri) return;
  try {
    let granted = await isPermissionGranted();
    if (!granted) {
      const permission = await requestPermission();
      granted = permission === "granted";
    }
    notificationPermissionReady = granted;
  } catch (err) {
    console.warn("Could not initialize notifications:", err);
  }
}

async function triggerNotification(title, body) {
  if (!isTauri) {
    console.log(`[Notification] ${title}: ${body}`);
    return;
  }
  if (!notificationPermissionReady) {
    await initNotifications();
  }
  try {
    sendNotification({ title, body });
  } catch (err) {
    console.warn("Failed to send desktop notification:", err);
  }
}

function isWeekday(date = new Date()) {
  const day = date.getDay();
  return day >= 1 && day <= 5;
}

export async function evaluateReminders(currentState) {
  const cfg = CONFIG.REMINDERS;
  if (!cfg) return;

  const now = new Date();
  if (cfg.weekdaysOnly && !isWeekday(now)) {
    return;
  }

  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const checkInDeadline = cfg.checkInByHour * 60 + cfg.checkInByMinute; // 10:00 AM = 600 min
  const checkOutDeadline = cfg.checkOutAfterHour * 60 + cfg.checkOutAfterMinute; // 7:00 PM = 1140 min
  const repeatMs = (cfg.repeatEveryMinutes || 10) * 60 * 1000;
  const nowMs = now.getTime();

  // 1. Clock-in reminders:
  // Starts after 10:00 AM every 10 min if not clocked in.
  // As soon as user clocks in (or if shift is already finished), stop immediately.
  if (!currentState.checkedIn && !currentState.shiftDone) {
    if (currentMinutes >= checkInDeadline && currentMinutes < checkOutDeadline) {
      if (nowMs - lastCheckInNag >= repeatMs) {
        lastCheckInNag = nowMs;
        await triggerNotification(
          'Clocky Reminder',
          'It is past 10:00 AM and you have not clocked in yet! Time to clock in.'
        );
      }
    }
  } else {
    // Clocked in or shift already done -> stop sending clock-in reminders
    lastCheckInNag = 0;
  }

  // 2. Clock-out reminders:
  // Starts from 7:00 PM (19:00) every 10 min until user clocks out.
  // As soon as user clocks out, stop immediately.
  if (currentState.checkedIn && !currentState.shiftDone) {
    if (currentMinutes >= checkOutDeadline) {
      if (nowMs - lastCheckOutNag >= repeatMs) {
        lastCheckOutNag = nowMs;
        await triggerNotification(
          'Clocky Reminder',
          'It is past 7:00 PM! Do not forget to clock out for the day.'
        );
      }
    }
  } else {
    // Clocked out or shift finished -> stop sending clock-out reminders
    lastCheckOutNag = 0;
  }

  // 3. Health & Wellness nudges (drink water, stretch arms, posture check):
  // Fires periodically while working (clocked in) between 10 AM and 7 PM.
  const wellnessCfg = CONFIG.WELLNESS;
  if (wellnessCfg?.enabled && currentState.checkedIn && !currentState.shiftDone) {
    const wellnessIntervalMs = (wellnessCfg.intervalMinutes || 60) * 60 * 1000;
    if (lastWellnessNudge === 0) {
      // First check after clocking in: schedule next alert after interval
      lastWellnessNudge = nowMs;
    } else if (nowMs - lastWellnessNudge >= wellnessIntervalMs) {
      lastWellnessNudge = nowMs;
      const prompts = wellnessCfg.prompts || [];
      if (prompts.length > 0) {
        const item = prompts[wellnessIndex % prompts.length];
        wellnessIndex++;
        await triggerNotification(item.title, item.body);
      }
    }
  } else {
    lastWellnessNudge = 0;
  }
}

export function getStreak() {
  try {
    const raw = localStorage.getItem("clocky_streak_data");
    if (!raw) return 0;
    const data = JSON.parse(raw);
    return data.count || 0;
  } catch {
    return 0;
  }
}

export function recordCheckInForStreak(checkInTimeStr) {
  try {
    const date = checkInTimeStr ? new Date(checkInTimeStr) : new Date();
    const cfg = CONFIG.REMINDERS;
    const deadlineMinutes =
      (cfg?.checkInByHour ?? 10) * 60 + (cfg?.checkInByMinute ?? 0);
    const checkInMinutes = date.getHours() * 60 + date.getMinutes();
    const isOnTime = checkInMinutes <= deadlineMinutes;

    const todayStr = date.toISOString().slice(0, 10);
    const raw = localStorage.getItem("clocky_streak_data");
    let data = raw ? JSON.parse(raw) : { count: 0, lastDate: null };

    if (data.lastDate === todayStr) {
      return data.count;
    }

    if (isOnTime) {
      data.count = (data.count || 0) + 1;
      data.lastDate = todayStr;
      localStorage.setItem("clocky_streak_data", JSON.stringify(data));
      return data.count;
    } else {
      data.count = 0;
      data.lastDate = todayStr;
      localStorage.setItem("clocky_streak_data", JSON.stringify(data));
      return 0;
    }
  } catch (err) {
    console.warn("Failed to update streak:", err);
    return 0;
  }
}
