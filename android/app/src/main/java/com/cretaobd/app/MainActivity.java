package com.cretaobd.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothSocket;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.print.PrintAttributes;
import android.print.PrintManager;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.core.content.FileProvider;
import androidx.webkit.WebViewAssetLoader;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.UUID;

/**
 * Creta OBD: shows the bundled dashboard (assets/www) in a WebView and gives it a classic
 * Bluetooth serial link to the paired ELM327 adapter through the "AndroidBT" JavaScript bridge.
 *
 * The bridge only moves bytes. All OBD logic, including the read-only command guard and the
 * user-confirmed "clear codes" flow, lives in obd-engine.js, the same code as the website.
 */
public class MainActivity extends Activity {
    private static final UUID SPP = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");
    private static final String HOST = "appassets.androidplatform.net";

    private static final int REQ_LOCATION = 2;
    private String geoOrigin;
    private GeolocationPermissions.Callback geoCallback;
    private WebView web;
    private FrameLayout root;
    private int barColor = 0xFF0B0F14;
    private volatile BluetoothSocket socket;
    private volatile OutputStream out;
    private volatile boolean running;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                return loader.shouldInterceptRequest(req.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (HOST.equals(u.getHost())) return false;
                // links to other sites (e.g. GitHub) open in the browser, not inside the app
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
                return true;
            }
        });
        s.setGeolocationEnabled(true);
        web.setWebChromeClient(new WebChromeClient() {
            // trip routes: the page asks for location -> ask Android for permission once, then answer the page
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
                        || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED) {
                    callback.invoke(origin, true, false);
                } else {
                    geoOrigin = origin; geoCallback = callback;
                    requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, REQ_LOCATION);
                }
            }
        });
        web.addJavascriptInterface(new Bridge(), "AndroidBT");

        // Android 15 draws apps edge-to-edge, under the status and navigation bars.
        // Pad the content by the system-bar insets so the dashboard header isn't hidden behind the clock.
        root = new FrameLayout(this);
        root.setBackgroundColor(barColor);
        web.setBackgroundColor(barColor);
        root.addView(web, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            int l, t, r, b;
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets in = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                l = in.left; t = in.top; r = in.right; b = in.bottom;
            } else {
                l = insets.getSystemWindowInsetLeft(); t = insets.getSystemWindowInsetTop();
                r = insets.getSystemWindowInsetRight(); b = insets.getSystemWindowInsetBottom();
            }
            v.setPadding(l, t, r, b);
            return insets;
        });
        setContentView(root);
        applyBarColor(barColor);
        web.loadUrl("https://" + HOST + "/assets/www/index.html");
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack(); else super.onBackPressed();
    }

    /** Colour behind the status/navigation bars, matching the dashboard theme; picks dark or light bar icons. */
    @SuppressWarnings("deprecation")
    private void applyBarColor(int color) {
        barColor = color;
        if (root != null) root.setBackgroundColor(color);
        Window w = getWindow();
        if (Build.VERSION.SDK_INT < 35) { w.setStatusBarColor(color); w.setNavigationBarColor(color); }
        int r = (color >> 16) & 0xFF, g = (color >> 8) & 0xFF, b = color & 0xFF;
        boolean light = (r * 299 + g * 587 + b * 114) / 1000 > 150;
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController c = w.getInsetsController();
            if (c != null) {
                int mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                c.setSystemBarsAppearance(light ? mask : 0, mask);
            }
        } else {
            int f = w.getDecorView().getSystemUiVisibility();
            f = light ? (f | View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR) : (f & ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
            w.getDecorView().setSystemUiVisibility(f);
        }
    }

    private void js(final String code) {
        if (web != null) web.post(() -> web.evaluateJavascript(code, null));
    }

    private void log(String msg) {
        js("window.__btLog && window.__btLog(" + JSONObject.quote(msg) + ")");
    }

    private boolean hasPermission() {
        return Build.VERSION.SDK_INT < 31
                || checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED;
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        boolean ok = false;
        for (int r : results) ok |= r == PackageManager.PERMISSION_GRANTED;
        if (code == REQ_LOCATION) {
            if (geoCallback != null) geoCallback.invoke(geoOrigin, ok, false);
            geoCallback = null;
            return;
        }
        js("window.__btPerm && window.__btPerm(" + ok + ")");
    }

    private BluetoothAdapter adapter() {
        BluetoothManager m = (BluetoothManager) getSystemService(BLUETOOTH_SERVICE);
        return m == null ? null : m.getAdapter();
    }

    /** Methods callable from JavaScript as window.AndroidBT.* */
    class Bridge {
        @JavascriptInterface
        public String listPaired() {
            if (!hasPermission()) {
                runOnUiThread(() -> requestPermissions(new String[]{Manifest.permission.BLUETOOTH_CONNECT}, 1));
                return "{\"error\":\"PERMISSION\"}";
            }
            BluetoothAdapter a = adapter();
            if (a == null) return "{\"error\":\"NO_BT\"}";
            try {
                if (!a.isEnabled()) return "{\"error\":\"BT_OFF\"}";
                JSONArray arr = new JSONArray();
                for (BluetoothDevice d : a.getBondedDevices()) {
                    JSONObject o = new JSONObject();
                    o.put("name", d.getName() == null ? "" : d.getName());
                    o.put("address", d.getAddress());
                    arr.put(o);
                }
                return "{\"devices\":" + arr + "}";
            } catch (SecurityException | JSONException e) {
                return "{\"error\":" + JSONObject.quote(e.toString()) + "}";
            }
        }

        @JavascriptInterface
        public void connect(final String address) {
            new Thread(() -> {
                String err = "";
                try { openSocket(address); } catch (Exception e) { err = e.getClass().getSimpleName() + ": " + e.getMessage(); }
                js("window.__btConnected && window.__btConnected(" + JSONObject.quote(err) + ")");
            }, "bt-connect").start();
        }

        @JavascriptInterface
        public void write(String data) {
            OutputStream o = out;
            if (o == null) return;
            try {
                o.write(data.getBytes(StandardCharsets.ISO_8859_1));
                o.flush();
            } catch (IOException e) {
                closeSocket();
                js("window.__btClosed && window.__btClosed(" + JSONObject.quote("write failed: " + e.getMessage()) + ")");
            }
        }

        @JavascriptInterface
        public void disconnect() { closeSocket(); }

        @JavascriptInterface
        public String version() { return "2"; }

        /** Save text (CSV / JSON report) to the app cache and open Android's share sheet (Drive, Gmail, WhatsApp, Files…). */
        @JavascriptInterface
        public void shareFile(String name, String mime, String content) {
            try {
                File dir = new File(getCacheDir(), "exports");
                if (!dir.exists() && !dir.mkdirs()) throw new IOException("cannot create export folder");
                File f = new File(dir, name.replaceAll("[^A-Za-z0-9._-]", "_"));
                try (FileOutputStream fo = new FileOutputStream(f)) { fo.write(content.getBytes(StandardCharsets.UTF_8)); }
                Uri uri = FileProvider.getUriForFile(MainActivity.this, "com.cretaobd.app.files", f);
                Intent send = new Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM, uri)
                        .putExtra(Intent.EXTRA_SUBJECT, name).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                runOnUiThread(() -> startActivity(Intent.createChooser(send, "Save or share " + name)));
            } catch (Exception e) {
                js("window.toast && toast(" + JSONObject.quote("Export failed: " + e.getMessage()) + ")");
            }
        }

        /** Print the page (the report view) — Android's print dialog also offers "Save as PDF". */
        @JavascriptInterface
        public void printPage(final String jobName) {
            runOnUiThread(() -> {
                PrintManager pm = (PrintManager) getSystemService(PRINT_SERVICE);
                if (pm != null && web != null) pm.print(jobName, web.createPrintDocumentAdapter(jobName), new PrintAttributes.Builder().build());
            });
        }

        /** Theme colour from the dashboard, e.g. "#0b0f14" */
        @JavascriptInterface
        public void setBarColor(final String hex) {
            try {
                final int c = Color.parseColor(hex.trim());
                runOnUiThread(() -> { applyBarColor(c); if (web != null) web.setBackgroundColor(c); });
            } catch (IllegalArgumentException ignored) { }
        }
    }

    /**
     * Cheap ELM327 clones often reject the standard secure SPP socket, so try three ways,
     * the same fallbacks native OBD apps use: secure SPP, insecure SPP, then RFCOMM channel 1 directly.
     */
    private void openSocket(String address) throws Exception {
        closeSocket();
        BluetoothAdapter a = adapter();
        if (a == null) throw new IOException("No Bluetooth adapter");
        try { a.cancelDiscovery(); } catch (SecurityException ignored) { }
        BluetoothDevice d = a.getRemoteDevice(address);
        String[] names = {"secure SPP", "insecure SPP", "RFCOMM channel 1"};
        Exception last = null;
        for (int i = 0; i < 3; i++) {
            BluetoothSocket s = null;
            try {
                log("Native: trying " + names[i] + "…");
                if (i == 0) s = d.createRfcommSocketToServiceRecord(SPP);
                else if (i == 1) s = d.createInsecureRfcommSocketToServiceRecord(SPP);
                else {
                    Method m = d.getClass().getMethod("createRfcommSocket", int.class);
                    s = (BluetoothSocket) m.invoke(d, 1);
                }
                s.connect();
                socket = s;
                out = s.getOutputStream();
                log("Native: connected using " + names[i]);
                startReader(s.getInputStream());
                return;
            } catch (Exception e) {
                last = e;
                log("Native: " + names[i] + " failed (" + e.getMessage() + ")");
                if (s != null) try { s.close(); } catch (IOException ignored) { }
            }
        }
        throw last;
    }

    private void startReader(final InputStream in) {
        running = true;
        new Thread(() -> {
            byte[] buf = new byte[1024];
            try {
                while (running) {
                    int n = in.read(buf);
                    if (n < 0) break;
                    if (n > 0) {
                        String chunk = new String(buf, 0, n, StandardCharsets.ISO_8859_1);
                        js("window.__btData && window.__btData(" + JSONObject.quote(chunk) + ")");
                    }
                }
            } catch (IOException ignored) { }
            if (running) {
                closeSocket();
                js("window.__btClosed && window.__btClosed('Bluetooth link lost')");
            }
        }, "bt-reader").start();
    }

    private void closeSocket() {
        running = false;
        BluetoothSocket s = socket;
        socket = null;
        out = null;
        if (s != null) try { s.close(); } catch (IOException ignored) { }
    }

    @Override
    protected void onDestroy() {
        closeSocket();
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
