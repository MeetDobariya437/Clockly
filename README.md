# Clocky ⏰✨

> **Clocky** is a tiny, fun desktop attendance widget for your company's HRMS. Employees keep it floating on their screen so they never forget to check in and check out!

Built with **Tauri v2** + **Vanilla HTML/CSS/JS** with local assets and zero heavy frameworks, keeping the installed footprint tiny (~10 MB).

---

## 🎨 Features

- **Chunky Mascot Aesthetic**: Retro-cute 3px ink outlines, 28px card radius, hard offset shadows, custom animations (breathing, hopping, blinking, floating Zs).
- **Responsive Mascot Moods**: Lavender and sleepy when checked out, bright butter yellow and hopping when checked in, grumpy when late, celebratory on Fridays! Click Clocky to make it wiggle and say something silly.
- **Secure by Default**: Auth tokens stored in the OS Keychain (via Windows Credential Manager / macOS Keychain). Zero tokens or passwords in `localStorage`.
- **Location-Aware Check-In**: Windows Geolocation API (`Windows.Devices.Geolocation`) with WebView2 fallback and optional IP lookup. Coordinates cached for 60s.
- **System Tray Integration**:
  - Live dot color: 🟢 Green when checked in, 🟣 Lavender/Grey when checked out.
  - Quick action menu: Show/Hide, Check in/out, Autostart toggle, Log out, Quit.
  - Clicking widget `x` hides to tray without quitting.
- **Smart Reminders**: Desktop notifications for morning check-in and evening check-out with weekday-only filters and configurable repeat intervals.
- **Single Instance & Window State**: Restores position safely on screen; second launches focus the existing widget.
- **Mock Mode**: Out-of-the-box UI sandbox testing with no backend required.

---

## 🛠️ Prerequisites

Before running or building Clocky on Windows:

1. **Node.js**: v18 or v20+ LTS ([nodejs.org](https://nodejs.org/)).
2. **Rust & Cargo**:
   - Install using [rustup.rs](https://rustup.rs/) (select 64-bit MSVC).
3. **C++ Build Tools**:
   - Visual Studio 2022 C++ Build Tools (or Visual Studio Community with "Desktop development with C++").
4. **Microsoft Edge WebView2**: Pre-installed on Windows 10 (recent updates) & Windows 11.

---

## 🚀 Quick Start (Mock Mode)

Clocky comes with `CONFIG.MOCK: true` enabled by default in `src/config.js` so you can test the entire workflow immediately without configuring an HRMS backend:

```bash
# 1. Install dependencies
npm install

# 2. Run in development mode
npm run tauri dev
```

### Testing in Mock Mode
1. **Login Screen**: Clocky will start in the login view. Enter any username and password (e.g. `test@example.com` / `password123`) and click **Wake me up**. (Entering `fail` as the username triggers a mock credential error).
2. **Main Screen**: Clocky transitions to sleep mode. Click **Wake me up** to simulate location verification and check in.
3. **Awake State**: The card background turns fresh mint, Clocky turns butter yellow and begins hopping, and worked time updates dynamically.
4. **Click the Mascot**: Tap Clocky to make it wiggle and display random speech bubbles.
5. **Check Out**: Click **Check out** to complete the shift.

---

## ⚙️ Connecting Your Real HRMS (`src/config.js`)

All endpoints, payload structures, and parsing logic live in **one single file**: `src/config.js`. You do not need to modify any other file in the repository.

### Step-by-Step Configuration

1. Open [`src/config.js`](file:///c:/Users/Jay%20Bhingradiya/Desktop/Projects/funclockin/src/config.js).
2. Disable Mock Mode:
   ```js
   MOCK: false,
   ```
3. Set your backend base URL:
   ```js
   BASE_URL: "https://your-hrms-company.com/api",
   ```
   *(Note: For security, non-HTTPS URLs are rejected unless set to `http://localhost:*`)*.
4. Update Endpoint Paths:
   ```js
   ENDPOINTS: {
     LOGIN:     { method: "POST", path: "/v1/auth/login" },
     STATUS:    { method: "GET",  path: "/v1/attendance/today" },
     CHECK_IN:  { method: "POST", path: "/v1/attendance/check-in" },
     CHECK_OUT: { method: "POST", path: "/v1/attendance/check-out" },
     LOCATION:  { method: "POST", path: "/v1/attendance/location", enabled: false },
   },
   ```
5. Adjust Login Request and Token Location:
   ```js
   // Adjust property names expected by your login endpoint:
   LOGIN_BODY: (username, password) => ({ email: username, password }),

   // Dot-delimited path to the auth token in your login response:
   TOKEN_PATH: "data.token", // or "token", "data.jwt", etc.

   // Format of the Authorization header sent on all authenticated calls:
   AUTH_HEADER: (token) => ({ Authorization: `Bearer ${token}` }),
   ```
6. Set Location Mode:
   - If your check-in/out body takes location directly:
     ```js
     LOCATION_MODE: "inline",
     LOCATION_BODY: (loc) => ({ latitude: loc.lat, longitude: loc.lng, accuracy: loc.accuracy }),
     ```
   - If your backend requires an initial POST to `ENDPOINTS.LOCATION`:
     ```js
     LOCATION_MODE: "separate",
     ```
7. Configure Attendance Status Parser:
   ```js
   PARSE_STATUS: (json) => ({
     checkedIn: !!json?.data?.checkInTime && !json?.data?.checkOutTime,
     checkInTime: json?.data?.checkInTime ?? null,
   }),
   ```
8. Set Reminder Deadlines:
   ```js
   REMINDERS: {
     checkInByHour: 10,      // Nag if not checked in by 10:00 AM
     checkInByMinute: 0,
     checkOutAfterHour: 19,  // Nag if still checked in after 7:00 PM
     checkOutAfterMinute: 0,
     repeatEveryMinutes: 30,
     weekdaysOnly: true,
   },
   ```

---

## 📍 Windows Location Services

Clocky requests high-accuracy geolocation via the Windows Native Geolocation API (`Windows.Devices.Geolocation.Geolocator`).

For Windows to allow location access:
1. Open Windows **Settings** (`Win + I`).
2. Go to **Privacy & Security** > **Location**.
3. Ensure **Location services** is toggled **On**.
4. Under "Let apps access your location", ensure it is toggled **On**.
5. Under "Let desktop apps access your location", ensure it is toggled **On**.

If location is turned off or blocked, Clocky surfaces a clear prompt and retry button:
> *"Location is off. Turn on Windows Location services (Settings > Privacy > Location) and try again."*

*(Optional: Set `ALLOW_IP_FALLBACK: true` in `config.js` if you wish to allow IP-based approximate location when Windows GPS/WiFi positioning is unavailable)*.

---

## 📦 Building the Production Installer

To produce a production installer (.msi / .exe):

```bash
npm run tauri build
```

- **Output Directory**: `src-tauri/target/release/bundle/nsis/` or `msi/`
- **Expected Installer Size**: **~5 MB to 8 MB** (exceeds the ~10 MB budget requirement comfortably!).

---

## 🔍 Troubleshooting Guide

### 1. Location not working or error displayed
- Check Windows **Settings > Privacy & security > Location** and ensure desktop app location access is enabled.
- If testing on a virtual machine or PC without WiFi/GPS hardware, Windows may report unavailable coordinates. Set `ALLOW_IP_FALLBACK: true` in `src/config.js` for testing.

### 2. CORS or Network Issues
- All network requests are dispatched through Tauri's native Rust HTTP client (`@tauri-apps/plugin-http`), completely bypassing browser CORS restrictions.
- Ensure your `BASE_URL` uses `https://` (non-HTTPS URLs are rejected by security policy).
- Check that the host is permitted in `src-tauri/capabilities/default.json`.

### 3. White Window Flash on Startup
- Clocky configures `transparent: true` on the webview window in `tauri.conf.json` and sets `background: transparent !important` on `html, body`.
- Vite dev mode might show a brief flash before styles mount; production builds (`npm run tauri build`) render completely transparent without flash.

### 4. Tray Icon Missing on Windows
- Windows automatically hides new tray icons in the overflow chevron (`^`). Click the taskbar chevron and drag Clocky's icon onto the taskbar so it remains permanently visible.

---

## 📁 Project Structure

```
clocky/
  package.json              # Scripts & Tauri JS dependencies
  vite.config.js            # Minimal bundler config
  src/
    index.html              # Transparent widget mount
    styles.css              # Chunky outlines, animations, fonts, tokens
    main.js                 # UI state machine & interactions
    api.js                  # Tauri HTTP requests, keyring auth, error handling
    location.js             # Native Windows geolocation & webview fallback
    reminders.js            # Notification rules & on-time streak tracker
    config.js               # ONLY configuration file for HRMS endpoints
    assets/fonts/
      Baloo2-600.woff2      # Bundled local fonts
      Baloo2-800.woff2
  src-tauri/
    Cargo.toml              # Rust dependencies (keyring, windows, tauri plugins)
    tauri.conf.json         # Frameless, transparent window config & app bundle
    capabilities/
      default.json          # Tauri v2 permission definitions
    icons/                  # App icon and green/grey tray icons
    src/
      lib.rs                # Tray icon, single-instance, autostart, keyring & location commands
      main.rs               # Windows subsystem entry point
  README.md
```

