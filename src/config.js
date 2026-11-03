export const CONFIG = {
  // Set to false to use the live backend from endpoints.txt, or true for local mock mode
  MOCK: false,

  BASE_URL: "https://hrms-api.ebuilding.in/api",

  ENDPOINTS: {
    LOGIN:     { method: "POST", path: "/auth/login" },
    STATUS:    { method: "POST", path: "/attendance/history" },
    CHECK_IN:  { method: "POST", path: "/attendance" },
    CHECK_OUT: { method: "POST", path: "/attendance" },
    LOCATION:  { method: "POST", path: "/location", enabled: false },
  },

  // How the login request body is built and how the token is read from the response
  LOGIN_BODY: (username, password) => ({ email: username, password }),
  TOKEN_PATH: "token", // response is { user: {...}, token: "..." }
  AUTH_HEADER: (token) => ({ Authorization: `Bearer ${token}` }),

  // How location is sent on check-in / check-out
  LOCATION_MODE: "inline", // { latitude: ..., longitude: ... } sent directly in body
  LOCATION_BODY: (loc) => ({
    latitude: loc.lat,
    longitude: loc.lng,
  }),

  // Optional payload generator for POST status (history) endpoint
  STATUS_BODY: () => ({
    month: new Date().toISOString().slice(0, 7), // e.g. "2026-11"
  }),

  // How to read attendance state from the STATUS (history) and check-in/out responses
  PARSE_STATUS: (json) => {
    // 1. Check history response structure with todayRecord
    let record = json?.todayRecord;

    // If todayRecord is not provided or empty, try finding today's record in data array
    if (!record && Array.isArray(json?.data)) {
      const todayIso = new Date().toISOString().slice(0, 10);
      record = json.data.find((item) => {
        if (!item?.date && !item?.checkIn) return false;
        const itemDate = (item.checkIn || item.date || '').slice(0, 10);
        return itemDate === todayIso;
      }) || null;
    }

    if (!record && json?.data && !Array.isArray(json.data)) {
      record = json.data;
    }
    if (!record && json && !Array.isArray(json)) {
      record = json;
    }

    const checkIn = record?.checkIn || record?.checkInTime || null;
    const checkOut = record?.checkOut || record?.checkOutTime || null;
    const hasCheckedIn = Boolean(checkIn);
    const hasCheckedOut = Boolean(checkOut);
    const isShiftDone = hasCheckedIn && hasCheckedOut;
    const isCheckedIn = hasCheckedIn && !hasCheckedOut;

    return {
      checkedIn: isCheckedIn,
      shiftDone: isShiftDone,
      checkInTime: checkIn,
      checkOutTime: checkOut,
      workingHours: record?.workingHours ?? null,
      status: record?.status ?? null,
    };
  },

  REMINDERS: {
    checkInByHour: 10,     // nag if not checked in by 10:00 AM on weekdays
    checkInByMinute: 0,
    checkOutAfterHour: 19, // nag if still checked in after 7:00 PM (19:00)
    checkOutAfterMinute: 0,
    repeatEveryMinutes: 10, // repeat every 10 minutes until clocked in / clocked out
    weekdaysOnly: true,
  },

  // Health & Wellness nudges while clocked in
  WELLNESS: {
    enabled: true,
    intervalMinutes: 60, // Send a wellness tip every 60 minutes while working
    prompts: [
      {
        title: "Clocky: Drink Water! 💧",
        body: "Hydration check! Drink a glass of fresh water to keep your energy up.",
      },
      {
        title: "Clocky: Stretch Your Arms! 🙆",
        body: "Stretch your arms overhead, roll your shoulders, and loosen your wrists.",
      },
      {
        title: "Clocky: Posture Check! 🧘",
        body: "Straighten your back, relax your shoulders, and take a deep breath.",
      },
      {
        title: "Clocky: Rest Your Eyes! 👀",
        body: "Look away from the screen at something 20 feet away for 20 seconds.",
      },
      {
        title: "Clocky: Stand & Move! 🚶",
        body: "Stand up, stretch your legs, and take a quick 1-minute walk around.",
      },
    ],
  },

  // Fallback to approximate IP lookup if GPS/WiFi location is disabled on the OS
  ALLOW_IP_FALLBACK: true,
};
