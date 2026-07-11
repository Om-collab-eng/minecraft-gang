package com.minecraftergang.dashboard.api;

import com.minecraftergang.dashboard.MinecrafterGang;
import com.minecraftergang.dashboard.stats.StatTracker;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;
import fr.xephi.authme.AuthMe;
import fr.xephi.authme.api.v3.AuthMeApi;
import fr.xephi.authme.datasource.DataSource;
import org.bukkit.Bukkit;
import org.bukkit.entity.Player;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
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
        // Port change requires restart
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
        String json = mapToJson(obj);
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

    // Simple JSON builder (no external library needed)
    private String mapToJson(Object obj) {
        if (obj instanceof Map) {
            StringBuilder sb = new StringBuilder("{");
            boolean first = true;
            for (Map.Entry<?, ?> entry : ((Map<?, ?>) obj).entrySet()) {
                if (!first) sb.append(",");
                sb.append("\"").append(escapeJson(String.valueOf(entry.getKey()))).append("\":");
                sb.append(mapToJson(entry.getValue()));
                first = false;
            }
            return sb.append("}").toString();
        } else if (obj instanceof List) {
            StringBuilder sb = new StringBuilder("[");
            boolean first = true;
            for (Object item : (List<?>) obj) {
                if (!first) sb.append(",");
                sb.append(mapToJson(item));
                first = false;
            }
            return sb.append("]").toString();
        } else if (obj instanceof Boolean || obj instanceof Number) {
            return String.valueOf(obj);
        } else if (obj == null) {
            return "null";
        } else {
            return "\"" + escapeJson(String.valueOf(obj)) + "\"";
        }
    }

    private String escapeJson(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "\\r");
    }

    private Map<String, Object> jsonToMap(String json) {
        Map<String, Object> map = new HashMap<>();
        json = json.trim();
        if (!json.startsWith("{")) return map;
        json = json.substring(1, json.length() - 1).trim();
        if (json.isEmpty()) return map;

        // Simple key-value parser
        String[] pairs = json.split(",(?=(?:[^\"]*\"[^\"]*\")*[^\"]*$)");
        for (String pair : pairs) {
            String[] kv = pair.split(":", 2);
            if (kv.length == 2) {
                String key = kv[0].trim().replace("\"", "").replace("}", "");
                String val = kv[1].trim().replace("\"", "").replace("}", "");
                map.put(key, val);
            }
        }
        return map;
    }

    // ─── /api/login — AuthMe password verification ────────────────────

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
            Map<String, Object> req = jsonToMap(body);
            String username = String.valueOf(req.getOrDefault("username", ""));
            String password = String.valueOf(req.getOrDefault("password", ""));

            if (username.isEmpty() || password.isEmpty()) {
                sendJson(ex, 400, Map.of("ok", false, "error", "Missing username or password"));
                return;
            }

            // Use AuthMe API to check password
            try {
                AuthMeApi authMeApi = AuthMeApi.getInstance();
                DataSource dataSource = authMeApi.getDataSource();

                // Check if user is registered
                boolean isRegistered = dataSource.isRegistered(username);
                if (!isRegistered) {
                    sendJson(ex, 401, Map.of("ok", false, "error", "Player not registered"));
                    return;
                }

                // Get the stored password hash
                String storedHash = dataSource.getPassword(username);
                if (storedHash == null || storedHash.isEmpty()) {
                    sendJson(ex, 401, Map.of("ok", false, "error", "No password stored for this player"));
                    return;
                }

                // Use AuthMe's own password checking (supports all hash formats)
                boolean valid = authMeApi.checkPassword(
                    fr.xephi.authme.api.v3.AuthMeApi.getInstance().getPlugin(),
                    username,
                    password
                );

                // Fallback: if the above doesn't work, try the DataSource check
                if (!valid) {
                    // Some AuthMe versions: checkPassword(DataSource, username, password)
                    valid = fr.xephi.authme.api.v3.AuthMeApi.getInstance()
                        .checkPassword(dataSource, username, password);
                }

                if (valid) {
                    // Get the real name (capitalized)
                    String realName = dataSource.getRealName(username);
                    if (realName == null || realName.isEmpty()) {
                        realName = username;
                    }

                    plugin.getLogger().info("[API] Login SUCCESS: " + realName);
                    sendJson(ex, 200, Map.of(
                        "ok", true,
                        "username", realName
                    ));
                } else {
                    plugin.getLogger().info("[API] Login FAILED: " + username);
                    sendJson(ex, 401, Map.of("ok", false, "error", "Invalid password"));
                }
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

            // Also try query param
            if (username.isEmpty()) {
                String query = ex.getRequestURI().getQuery();
                if (query != null) {
                    for (String param : query.split("&")) {
                        String[] kv = param.split("=", 2);
                        if (kv.length == 2 && kv[0].equals("username")) {
                            username = kv[1];
                        }
                    }
                }
            }

            if (username.isEmpty()) {
                sendJson(ex, 400, Map.of("ok", false, "error", "Missing username. Use /api/stats/<username>"));
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

    // ─── /api/online — List online players with live data ────────────

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
                data.put("exp", Math.round(p.getExp() * 100.0) / 10.0);
                data.put("gamemode", p.getGameMode().name());
                data.put("ip", p.getAddress() != null ? p.getAddress().getAddress().getHostAddress() : "unknown");

                // Merged stats
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

    // ─── /api/status — Plugin health check ────────────────────────────

    class StatusHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange ex) throws IOException {
            if ("OPTIONS".equalsIgnoreCase(ex.getRequestMethod())) {
                sendCors(ex);
                ex.sendResponseHeaders(204, -1);
                return;
            }

            Map<String, Object> status = new LinkedHashMap<>();
            status.put("ok", true);
            status.put("plugin", "MinecrafterGang");
            status.put("version", plugin.getDescription().getVersion());
            status.put("online", Bukkit.getOnlinePlayers().size());
            status.put("maxPlayers", Bukkit.getMaxPlayers());
            status.put("serverVersion", Bukkit.getBukkitVersion());
            status.put("authme", isAuthMeLoaded());
            sendJson(ex, 200, status);
        }

        private boolean isAuthMeLoaded() {
            return Bukkit.getPluginManager().getPlugin("AuthMe") != null;
        }
    }
}
