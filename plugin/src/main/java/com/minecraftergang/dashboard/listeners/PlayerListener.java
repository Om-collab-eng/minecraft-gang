package com.minecraftergang.dashboard.listeners;

import com.minecraftergang.dashboard.MinecrafterGang;
import com.minecraftergang.dashboard.stats.StatTracker;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.entity.EntityDamageByEntityEvent;
import org.bukkit.event.entity.PlayerDeathEvent;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.event.player.PlayerMoveEvent;

public class PlayerListener implements Listener {

    private final MinecrafterGang plugin;
    private final StatTracker statTracker;

    public PlayerListener(MinecrafterGang plugin, StatTracker statTracker) {
        this.plugin = plugin;
        this.statTracker = statTracker;
    }

    @EventHandler
    public void onJoin(PlayerJoinEvent event) {
        String name = event.getPlayer().getName();
        statTracker.onPlayerJoin(name);
        plugin.getLogger().info("[Stats] " + name + " joined — tracking started");
    }

    @EventHandler
    public void onQuit(PlayerQuitEvent event) {
        String name = event.getPlayer().getName();
        statTracker.onPlayerQuit(name);
        plugin.getLogger().info("[Stats] " + name + " left — playtime saved");
    }

    @EventHandler
    public void onDeath(PlayerDeathEvent event) {
        Player victim = event.getEntity();
        Player killer = victim.getKiller();

        String victimName = victim.getName();
        String killerName = killer != null ? killer.getName() : null;

        statTracker.onDeath(victimName, killerName);
        plugin.getLogger().info("[Stats] " + victimName + " died" + (killerName != null ? " (killed by " + killerName + ")" : ""));
    }

    @EventHandler
    public void onDamage(EntityDamageByEntityEvent event) {
        if (!(event.getEntity() instanceof Player)) return;
        Player victim = (Player) event.getEntity();
        double amount = event.getFinalDamage();

        String attackerName = null;
        if (event.getDamager() instanceof Player) {
            attackerName = ((Player) event.getDamager()).getName();
        }

        statTracker.onDamage(victim.getName(), amount, attackerName);
    }

    // Track jumps via vertical movement
    private final java.util.Map<String, Double> lastY = new java.util.HashMap<>();

    @EventHandler
    public void onMove(PlayerMoveEvent event) {
        Player player = event.getPlayer();
        String name = player.getName();
        double currentY = player.getLocation().getY();
        Double prevY = lastY.get(name);

        if (prevY != null) {
            // Detect upward movement (jump)
            if (currentY > prevY + 0.5 && player.isOnGround()) {
                // They were on ground and moved up — likely a jump
            } else if (currentY > prevY + 0.5 && !player.isOnGround()) {
                statTracker.onJump(name);
            }
        }
        lastY.put(name, currentY);
    }
}
