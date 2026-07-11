package com.minecraftergang.dashboard;

import com.minecraftergang.dashboard.api.DashboardApiServer;
import com.minecraftergang.dashboard.listeners.PlayerListener;
import com.minecraftergang.dashboard.stats.StatTracker;
import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.configuration.file.FileConfiguration;
import org.bukkit.plugin.java.JavaPlugin;

public class MinecrafterGang extends JavaPlugin {

    private static MinecrafterGang instance;
    private DashboardApiServer apiServer;
    private StatTracker statTracker;

    @Override
    public void onEnable() {
        instance = this;
        saveDefaultConfig();

        // Start stat tracker
        statTracker = new StatTracker(this);
        getServer().getPluginManager().registerEvents(new PlayerListener(this, statTracker), this);

        // Start HTTP API server
        FileConfiguration cfg = getConfig();
        int port = cfg.getInt("api.port", 8089);
        String apiKey = cfg.getString("api.key", "mg_change_me_to_a_random_secret");
        String corsOrigin = cfg.getString("cors-origin", "*");

        apiServer = new DashboardApiServer(this, statTracker, port, apiKey, corsOrigin);
        try {
            apiServer.start();
            getLogger().info("Dashboard API server started on port " + port);
        } catch (Exception e) {
            getLogger().severe("Failed to start API server: " + e.getMessage());
            getServer().getPluginManager().disablePlugin(this);
            return;
        }

        getLogger().info("MinecrafterGang Dashboard Bridge enabled!");
    }

    @Override
    public void onDisable() {
        if (apiServer != null) {
            apiServer.stop();
        }
        getLogger().info("MinecrafterGang Dashboard Bridge disabled.");
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        if (command.getName().equalsIgnoreCase("mgreload")) {
            reloadConfig();
            FileConfiguration cfg = getConfig();
            apiServer.updateConfig(
                cfg.getInt("api.port", 8089),
                cfg.getString("api.key", "mg_change_me_to_a_random_secret"),
                cfg.getString("cors-origin", "*")
            );
            sender.sendMessage("§a[MinecrafterGang] Config reloaded!");
            return true;
        }
        return false;
    }

    public static MinecrafterGang getInstance() {
        return instance;
    }
}
