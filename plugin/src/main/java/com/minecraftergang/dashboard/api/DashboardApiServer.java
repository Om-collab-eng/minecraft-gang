package com.minecraftergang.dashboard.api;

import com.minecraftergang.dashboard.MinecrafterGang;
import com.minecraftergang.dashboard.stats.StatTracker;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;
import org.bukkit.Bukkit;
import org.bukkit.entity.Player;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.reflect.Method;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.Executors;

public class DashboardApiServer {

    private final MinecrafterGang plugin;
    private final StatTracker statTracker;
    private HttpServer server;
    private int port;
    private String apiKey;
    private String corsOrigin;

    public DashboardApiServer(MinecrafterGang plugin, StatTracker statTracker, int port, String apiKey, String corsOrigin) {
        this.plugin = plugin;
        this.statTracker = statTracker;
        this.port = port;
        this.apiKey = apiKey;
        this.corsOrigin = corsOrigin;
    }

    public void start() throws IOException {
        server = HttpServer.create(new InetSocketAddress(port), 0);
        server.setExecutor(Executors.newFixedThreadPool(4));

        server.createContext("/api/login", new LoginHandler());
        server.createContext("/api/stats", new StatsHandler());
        server.createContext("/api/online", new OnlinePlayersHandler());
        server.createContext("/api/status", new StatusHandler());

        server.start();
    }

    public void stop() {
        if (server != null) {
            server.stop(1);
        }
    }

    public void updateConfig(int port, String apiKey, String corsOrigin) {
        this.apiKey = apiKey;
        this.corsOrigin = corsOrigin;
        if (this.port != port) {
            this.port = port;
            plugin.getLogger().info("Port changed to " + port + " — restart server for change to take effect.");
        }
    }

    // ─── HELPERS ──────────────────────────────────────────────────────

    private boolean checkAuth(HttpExchange ex) throws IOException {
        String key = ex.getRequestHeaders().getFirst("X-API-Key");
        if (!apiKey.equals(key)) {
            sendJson(ex, 401, Map.of("ok", false, "error", "Invalid API key"));
            return false;
        }
        return true;
    }

    private void sendCors(HttpExchange ex) {
        ex.getResponseHeaders().set("Access-Control-Allow-Origin", corsOrigin);
        ex.getResponseHeaders().set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        ex.getResponseHeaders().set("Access-Control-Allow-Headers", "Content-Type, X-API-Key");
    }

    @SuppressWarnings("unchecked")
    private void sendJson(HttpExchange ex, int code, Object obj) throws IOException {
        sendCors(ex);
        String json = toJson(obj);
        byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", "application/json");
        ex.sendResponseHeaders(code, bytes.length);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(bytes);
        }
    }

    private String readBody(HttpExchange ex) throws IOException {
        try (InputStream is = ex.getRequestBody()) {
            return new String(is.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    @SuppressWarnings("unchecked")
    private String toJson(Object obj) {
        if (obj instanceof Map) {
            StringBuilder sb = new StringBuilder("{");
            boolean first = true;
            for (Map.Entry<?, ?> entry : ((Map<?, ?>) obj).entrySet()) {
                if (!first) sb.append(",");
                sb.append("\"").append(esc(String.valueOf(entry.getKey()))).append("\":");
                sb.append(toJson(entry.getValue()));
                first = false;
            }
            return sb.append("}").toString();
        } else if (obj instanceof List) {
            StringBuilder sb = new StringBuilder("[");
            boolean first = true;
            for (Object item : (List<?>) obj) {
                if (!first) sb.append(",");
                sb.append(toJson(item));
                first = false;
            }
            return sb.append("]").toString();
        } else if (obj instanceof Boolean || obj instanceof Number) {
            return String.valueOf(obj);
        } else if (obj == null) {
            return "null";
        } else {
            return "\"" + esc(String.valueOf(obj)) + "\"";
        }
    }

    private String esc(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "\\r");
    }

    private Map<String, String> parseBody(String json) {
        Map<String, String> map = new HashMap<>();
        json = json.trim();
        if (!json.startsWith("{")) return map;
        json = json.substring(1, json.length() - 1).trim();
        if (json.isEmpty()) return map;
        String[] pairs = json.split(",(?=(?:[^\"]*\"[^\"]*\")*[^\"]*$)");
        for (String pair : pairs) {
            String[] kv = pair.split(":", 2);
            if (kv.length == 2) {
                String key = kv[0].trim().replace("\"", "");
                String val = kv[1].trim().replace("\"", "");
                map.put(key, val);
            }
        }
        return map;
    }

    // ─── /api/login — AuthMe via reflection ───────────────────────────

    class LoginHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange ex) throws IOException {
            if ("OPTIONS".equalsIgnoreCase(ex.getRequestMethod())) {
                sendCors(ex);
                ex.sendResponseHeaders(204, -1);
                return;
            }
            if (!"POST".equalsIgnoreCase(ex.getRequestMethod())) {
                sendJson(ex, 405, Map.of("ok", false, "error", "POST required"));
                return;
            }
            if (!checkAuth(ex)) return;

            String body = readBody(ex);
            Map<String, String> req = parseBody(body);
            String username = req.getOrDefault("username", "");
            String password = req.getOrDefault("password", "");

            if (username.isEmpty() || password.isEmpty()) {
                sendJson(ex, 400, Map.of("ok", false, "error", "Missing username or password"));
                return;
            }

            try {
                // Use AuthMe API via reflection (no compile dependency)
                Object authMeApi = Class.forName("fr.xephi.authme.api.v3.AuthMeApi").getMethod("getInstance").invoke(null);
                Object dataSource = authMeApi.getClass().getMethod("getDataSource").invoke(authMeApi);

                // Check if registered
                boolean isRegistered = (boolean) dataSource.getClass()
                    .getMethod("isRegistered", String.class)
                    .invoke(dataSource, username);

                if (!isRegistered) {
                    sendJson(ex, 401, Map.of("ok", false, "error", "Player not registered"));
                    return;
                }

                // Get stored password hash
                String storedHash = (String) dataSource.getClass()
                    .getMethod("getPassword", String.class)
                    .invoke(dataSource, username);

                if (storedHash == null || storedHash.isEmpty()) {
                    sendJson(ex, 401, Map.of("ok", false, "error", "No password stored"));
                    return;
                }

                // Try checkPassword via AuthMe API
                boolean valid = false;
                try {
                    Method checkPw = authMeApi.getClass().getMethod("checkPassword", String.class, String.class);
                    valid = (boolean) checkPw.invoke(authMeApi, username, password);
                } catch (NoSuchMethodException e) {
                    // Try alternative signature: checkPassword(DataSource, String, String)
                    try {
                        Method checkPw = authMeApi.getClass().getMethod("checkPassword", dataSource.getClass(), String.class, String.class);
                        valid = (boolean) checkPw.invoke(authMeApi, dataSource, username, password);
                    } catch (NoSuchMethodException e2) {
                        plugin.getLogger().warning("[API] Could not find AuthMe checkPassword method. AuthMe version may be incompatible.");
                    }
                }

                if (valid) {
                    String realName = username;
                    try {
                        realName = (String) dataSource.getClass()
                            .getMethod("getRealName", String.class)
                            .invoke(dataSource, username);
                        if (realName == null || realName.isEmpty()) realName = username;
                    } catch (Exception ignored) {}

                    plugin.getLogger().info("[API] Login SUCCESS: " + realName);
                    sendJson(ex, 200, Map.of("ok", true, "username", realName));
                } else {
                    plugin.getLogger().info("[API] Login FAILED: " + username);
                    sendJson(ex, 401, Map.of("ok", false, "error", "Invalid password"));
                }
            } catch (ClassNotFoundException e) {
                plugin.getLogger().severe("[API] AuthMe not found on server!");
                sendJson(ex, 500, Map.of("ok", false, "error", "AuthMe plugin not installed on server"));
            } catch (Exception e) {
                plugin.getLogger().severe("[API] Login error: " + e.getMessage());
                sendJson(ex, 500, Map.of("ok", false, "error", "AuthMe error: " + e.getMessage()));
            }
        }
    }

    // ─── /api/stats — Get player stats ────────────────────────────────

    class StatsHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange ex) throws IOException {
            if ("OPTIONS".equalsIgnoreCase(ex.getRequestMethod())) {
                sendCors(ex);
                ex.sendResponseHeaders(204, -1);
                return;
            }
            if (!checkAuth(ex)) return;

            String path = ex.getRequestURI().getPath();
            String username = path.replace("/api/stats/", "").replace("/api/stats", "");

            if (username.isEmpty()) {
                sendJson(ex, 400, Map.of("ok", false, "error", "Missing username"));
                return;
            }

            Map<String, Object> stats = statTracker.getStats(username);
            if (stats == null) {
                sendJson(ex, 200, Map.of("ok", true, "found", false, "username", username));
                return;
            }

            sendJson(ex, 200, Map.of("ok", true, "found", true, "stats", stats));
        }
    }

    // ─── /api/online — List online players ────────────────────────────

    class OnlinePlayersHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange ex) throws IOException {
            if ("OPTIONS".equalsIgnoreCase(ex.getRequestMethod())) {
                sendCors(ex);
                ex.sendResponseHeaders(204, -1);
                return;
            }
            if (!checkAuth(ex)) return;

            List<Map<String, Object>> players = new ArrayList<>();
            for (Player p : Bukkit.getOnlinePlayers()) {
                Map<String, Object> data = new LinkedHashMap<>();
                data.put("name", p.getName());
                data.put("uuid", p.getUniqueId().toString());
                data.put("health", Math.round(p.getHealth() * 10.0) / 10.0);
                data.put("maxHealth", p.getMaxHealth());
                data.put("food", p.getFoodLevel());
                data.put("level", p.getLevel());

                Map<String, Object> playerStats = statTracker.getStats(p.getName());
                if (playerStats != null) {
                    data.put("kills", playerStats.getOrDefault("playerKills", 0));
                    data.put("deaths", playerStats.getOrDefault("deaths", 0));
                    data.put("playTime", playerStats.getOrDefault("timePlayed", 0));
                }

                players.add(data);
            }

            Map<String, Object> response = new LinkedHashMap<>();
            response.put("ok", true);
            response.put("count", players.size());
            response.put("players", players);
            sendJson(ex, 200, response);
        }
    }

    // ─── /api/status — Health check ───────────────────────────────────

    class StatusHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange ex) throws IOException {
            if ("OPTIONS".equalsIgnoreCase(ex.getRequestMethod())) {
                sendCors(ex);
                ex.sendResponseHeaders(204, -1);
                return;
            }

            boolean authmeLoaded = false;
            try {
                Class.forName("fr.xephi.authme.api.v3.AuthMeApi");
                authmeLoaded = true;
            } catch (ClassNotFoundException ignored) {}

            Map<String, Object> status = new LinkedHashMap<>();
            status.put("ok", true);
            status.put("plugin", "MinecrafterGang");
            status.put("version", plugin.getDescription().getVersion());
            status.put("online", Bukkit.getOnlinePlayers().size());
            status.put("maxPlayers", Bukkit.getMaxPlayers());
            status.put("authme", authmeLoaded);
            sendJson(ex, 200, status);
        }
    }
}
