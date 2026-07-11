package com.minecraftergang.dashboard.stats;

import com.minecraftergang.dashboard.MinecrafterGang;
import org.bukkit.configuration.file.YamlConfiguration;

import java.io.File;
import java.io.IOException;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

public class StatTracker {

    private final MinecrafterGang plugin;
    private final Map<String, PlayerData> cache = new ConcurrentHashMap<>();
    private final File dataFolder;

    public static class PlayerData {
        public String name;
        public int deaths = 0;
        public int playerKills = 0;
        public int mobKills = 0;
        public long joinTime = 0;
        public long totalPlayTime = 0;
        public double damageDealt = 0;
        public double damageTaken = 0;
        public int jumps = 0;
    }

    public StatTracker(MinecrafterGang plugin) {
        this.plugin = plugin;
        this.dataFolder = new File(plugin.getDataFolder(), "playerdata");
        if (!dataFolder.exists()) {
            dataFolder.mkdirs();
        }
        loadAll();
    }

    public PlayerData getOrCreate(String name) {
        return cache.computeIfAbsent(name.toLowerCase(), k -> {
            PlayerData data = new PlayerData();
            data.name = name;
            return data;
        });
    }

    public void onPlayerJoin(String name) {
        PlayerData data = getOrCreate(name);
        data.joinTime = System.currentTimeMillis();
        save(name);
    }

    public void onPlayerQuit(String name) {
        PlayerData data = getOrCreate(name);
        if (data.joinTime > 0) {
            long session = (System.currentTimeMillis() - data.joinTime) / 1000;
            data.totalPlayTime += session;
            data.joinTime = 0;
        }
        save(name);
    }

    public void onDeath(String victim, String killer) {
        PlayerData data = getOrCreate(victim);
        data.deaths++;
        save(victim);

        if (killer != null && !killer.equals(victim)) {
            PlayerData killerData = getOrCreate(killer);
            killerData.playerKills++;
            save(killer);
        }
    }

    public void onMobKill(String killer) {
        PlayerData data = getOrCreate(killer);
        data.mobKills++;
        save(killer);
    }

    public void onDamage(String victim, double amount, String attacker) {
        PlayerData victimData = getOrCreate(victim);
        victimData.damageTaken += amount;
        save(victim);

        if (attacker != null) {
            PlayerData attackerData = getOrCreate(attacker);
            attackerData.damageDealt += amount;
            save(attacker);
        }
    }

    public void onJump(String player) {
        PlayerData data = getOrCreate(player);
        data.jumps++;
    }

    public Map<String, Object> getStats(String name) {
        PlayerData data = cache.get(name.toLowerCase());
        if (data == null) {
            data = load(name);
            if (data == null) return null;
        }

        long totalSeconds = data.totalPlayTime;
        if (data.joinTime > 0) {
            totalSeconds += (System.currentTimeMillis() - data.joinTime) / 1000;
        }

        Map<String, Object> stats = new LinkedHashMap<>();
        stats.put("username", data.name);
        stats.put("deaths", data.deaths);
        stats.put("playerKills", data.playerKills);
        stats.put("mobKills", data.mobKills);
        stats.put("timePlayed", totalSeconds);
        stats.put("damageDealt", Math.round(data.damageDealt * 10.0) / 10.0);
        stats.put("damageTaken", Math.round(data.damageTaken * 10.0) / 10.0);
        stats.put("jumps", data.jumps);
        return stats;
    }

    public void saveAll() {
        for (String name : cache.keySet()) {
            save(name);
        }
    }

    private File getFile(String name) {
        return new File(dataFolder, name.toLowerCase() + ".yml");
    }

    private void save(String name) {
        PlayerData data = cache.get(name.toLowerCase());
        if (data == null) return;

        YamlConfiguration yaml = new YamlConfiguration();
        yaml.set("name", data.name);
        yaml.set("deaths", data.deaths);
        yaml.set("playerKills", data.playerKills);
        yaml.set("mobKills", data.mobKills);
        yaml.set("totalPlayTime", data.totalPlayTime);
        yaml.set("damageDealt", data.damageDealt);
        yaml.set("damageTaken", data.damageTaken);
        yaml.set("jumps", data.jumps);

        try {
            yaml.save(getFile(name));
        } catch (IOException e) {
            plugin.getLogger().warning("Failed to save stats for " + name + ": " + e.getMessage());
        }
    }

    private PlayerData load(String name) {
        File file = getFile(name);
        if (!file.exists()) return null;

        YamlConfiguration yaml = YamlConfiguration.loadConfiguration(file);
        PlayerData data = new PlayerData();
        data.name = yaml.getString("name", name);
        data.deaths = yaml.getInt("deaths", 0);
        data.playerKills = yaml.getInt("playerKills", 0);
        data.mobKills = yaml.getInt("mobKills", 0);
        data.totalPlayTime = yaml.getLong("totalPlayTime", 0);
        data.damageDealt = yaml.getDouble("damageDealt", 0);
        data.damageTaken = yaml.getDouble("damageTaken", 0);
        data.jumps = yaml.getInt("jumps", 0);
        cache.put(name.toLowerCase(), data);
        return data;
    }

    private void loadAll() {
        File[] files = dataFolder.listFiles((dir, name) -> name.endsWith(".yml"));
        if (files == null) return;
        for (File file : files) {
            String playerName = file.getName().replace(".yml", "");
            load(playerName);
        }
        plugin.getLogger().info("Loaded stats for " + cache.size() + " players.");
    }
}
