# Minecraft Block Particle Implementation Checklist

This document tracks all particle types and particle-emitting blocks for implementation in Block Viewer.

---

## Particle Types (from `assets/minecraft/particles/`)

### Core Particles
| Particle Type | Texture Size | Animated | Status |
|---------------|--------------|----------|--------|
| `flame` | 8x8 | No | ✅ Implemented |
| `soul_fire_flame` | 8x8 | No | ✅ Implemented |
| `small_flame` | 8x8 | No | ✅ Implemented |
| `smoke` | 8x64 | Yes (8 frames) | ✅ Implemented |
| `large_smoke` | 8x64 | Yes (8 frames) | ✅ Implemented |
| `white_smoke` | 8x64 | Yes (8 frames) | ✅ Implemented |
| `campfire_cosy_smoke` | 16x192 | Yes (12 frames) | ✅ Implemented |
| `campfire_signal_smoke` | 16x192 | Yes (12 frames) | ✅ Implemented |
| `lava` | 8x8 | No | ✅ Implemented |
| `end_rod` | 8x8 | No | ✅ Implemented |
| `portal` | 8x64 | Yes (8 frames) | ✅ Implemented |
| `enchant` | 8x64 | Yes (26 SGA letters) | ✅ Implemented |

### Drip/Liquid Particles
| Particle Type | Texture Size | Animated | Status |
|---------------|--------------|----------|--------|
| `dripping_water` | 8x8 | No | ⬜ Not implemented |
| `falling_water` | 8x8 | No | ⬜ Not implemented |
| `dripping_lava` | 8x8 | No | ⬜ Not implemented |
| `falling_lava` | 8x8 | No | ⬜ Not implemented |
| `landing_lava` | 8x8 | No | ⬜ Not implemented |
| `dripping_honey` | 8x8 | No | ⬜ Not implemented |
| `falling_honey` | 8x8 | No | ⬜ Not implemented |
| `landing_honey` | 8x8 | No | ⬜ Not implemented |
| `dripping_obsidian_tear` | 8x8 | No | ⬜ Not implemented |
| `falling_obsidian_tear` | 8x8 | No | ⬜ Not implemented |
| `landing_obsidian_tear` | 8x8 | No | ⬜ Not implemented |
| `dripping_dripstone_water` | 8x8 | No | ⬜ Not implemented |
| `falling_dripstone_water` | 8x8 | No | ⬜ Not implemented |
| `dripping_dripstone_lava` | 8x8 | No | ⬜ Not implemented |
| `falling_dripstone_lava` | 8x8 | No | ⬜ Not implemented |

### Spore/Ambient Particles
| Particle Type | Texture Size | Animated | Status |
|---------------|--------------|----------|--------|
| `spore_blossom_air` | 8x8 | No | ✅ Implemented |
| `falling_spore_blossom` | 8x8 | No | ✅ Implemented |
| `falling_nectar` | 8x8 | No | ⬜ Not implemented |
| `crimson_spore` | 8x8 | No | ⬜ Not implemented |
| `warped_spore` | 8x8 | No | ⬜ Not implemented |
| `mycelium` | 8x8 | No | ⬜ Not implemented |
| `ash` | 8x8 | No | ⬜ Not implemented |
| `white_ash` | 8x8 | No | ⬜ Not implemented |

### Leaf Particles
| Particle Type | Texture Size | Animated | Status |
|---------------|--------------|----------|--------|
| `cherry_leaves` | 8x8 | No | ✅ Implemented |
| `pale_oak_leaves` | 8x8 | No | ⬜ Not implemented |
| `tinted_leaves` | 8x8 | No | ✅ Implemented |

### Effect Particles
| Particle Type | Texture Size | Animated | Status |
|---------------|--------------|----------|--------|
| `effect` | 8x64 | Yes | ⬜ Not implemented |
| `instant_effect` | 8x64 | Yes | ⬜ Not implemented |
| `entity_effect` | 8x8 | No | ⬜ Not implemented |
| `ambient_entity_effect` | 8x8 | No | ⬜ Not implemented |
| `witch` | 8x8 | No | ⬜ Not implemented |

### Bubble Particles
| Particle Type | Texture Size | Animated | Status |
|---------------|--------------|----------|--------|
| `bubble` | 8x8 | No | ⬜ Not implemented |
| `bubble_pop` | 8x40 | Yes (5 frames) | ⬜ Not implemented |
| `bubble_column_up` | 8x8 | No | ⬜ Not implemented |
| `current_down` | 8x8 | No | ⬜ Not implemented |
| `underwater` | 8x8 | No | ⬜ Not implemented |

### Dust/Redstone Particles
| Particle Type | Texture Size | Animated | Status |
|---------------|--------------|----------|--------|
| `dust` | 8x8 | No | ⬜ Not implemented |
| `dust_color_transition` | 8x8 | No | ⬜ Not implemented |
| `dust_plume` | 8x8 | No | ⬜ Not implemented |
| `falling_dust` | 8x8 | No | ⬜ Not implemented |

### Sculk Particles
| Particle Type | Texture Size | Animated | Status |
|---------------|--------------|----------|--------|
| `sculk_soul` | 8x64 | Yes | ⬜ Not implemented |
| `sculk_charge` | 8x64 | Yes | ⬜ Not implemented |
| `sculk_charge_pop` | 8x40 | Yes | ⬜ Not implemented |
| `shriek` | 8x40 | Yes | ⬜ Not implemented |
| `vibration` | 8x8 | No | ⬜ Not implemented |
| `sonic_boom` | 16x16 | No | ⬜ Not implemented |

### Misc Particles
| Particle Type | Texture Size | Animated | Status |
|---------------|--------------|----------|--------|
| `note` | 8x8 | No | ⬜ Not implemented |
| `heart` | 8x8 | No | ⬜ Not implemented |
| `happy_villager` | 8x8 | No | ⬜ Not implemented |
| `angry_villager` | 8x8 | No | ⬜ Not implemented |
| `cloud` | 8x64 | Yes | ⬜ Not implemented |
| `poof` | 8x64 | Yes | ⬜ Not implemented |
| `explosion` | 8x128 | Yes (16 frames) | ⬜ Not implemented |
| `flash` | 8x8 | No | ⬜ Not implemented |
| `crit` | 8x8 | No | ⬜ Not implemented |
| `enchanted_hit` | 8x8 | No | ⬜ Not implemented |
| `damage_indicator` | 8x8 | No | ⬜ Not implemented |
| `sweep_attack` | 8x64 | Yes | ⬜ Not implemented |
| `splash` | 8x16 | Yes (2 frames) | ⬜ Not implemented |
| `rain` | 8x8 | No | ⬜ Not implemented |
| `snowflake` | 8x8 | No | ⬜ Not implemented |
| `glow` | 8x8 | No | ⬜ Not implemented |
| `glow_squid_ink` | 8x8 | No | ⬜ Not implemented |
| `squid_ink` | 8x8 | No | ⬜ Not implemented |
| `spit` | 8x8 | No | ⬜ Not implemented |
| `sneeze` | 8x8 | No | ⬜ Not implemented |
| `composter` | 8x8 | No | ⬜ Not implemented |
| `nautilus` | 8x8 | No | ⬜ Not implemented |
| `dolphin` | 8x8 | No | ⬜ Not implemented |
| `fishing` | 8x8 | No | ⬜ Not implemented |
| `firework` | 8x8 | No | ⬜ Not implemented |
| `totem_of_undying` | 8x8 | No | ⬜ Not implemented |
| `dragon_breath` | 8x8 | No | ⬜ Not implemented |
| `soul` | 8x64 | Yes | ⬜ Not implemented |
| `reverse_portal` | 8x64 | Yes | ⬜ Not implemented |
| `electric_spark` | 8x8 | No | ⬜ Not implemented |
| `scrape` | 8x8 | No | ⬜ Not implemented |
| `wax_on` | 8x8 | No | ⬜ Not implemented |
| `wax_off` | 8x8 | No | ⬜ Not implemented |
| `egg_crack` | 8x32 | Yes (4 frames) | ⬜ Not implemented |
| `gust` | 8x96 | Yes (12 frames) | ⬜ Not implemented |
| `small_gust` | 8x24 | Yes (3 frames) | ⬜ Not implemented |
| `infested` | 8x8 | No | ⬜ Not implemented |
| `trail` | 8x8 | No | ⬜ Not implemented |
| `firefly` | 8x8 | No | ⬜ Not implemented |

### Trial/Vault Particles (1.21+)
| Particle Type | Texture Size | Animated | Status |
|---------------|--------------|----------|--------|
| `trial_spawner_detection` | 8x8 | No | ⬜ Not implemented |
| `trial_spawner_detection_ominous` | 8x8 | No | ⬜ Not implemented |
| `vault_connection` | 8x8 | No | ⬜ Not implemented |
| `trial_omen` | 8x8 | No | ⬜ Not implemented |
| `raid_omen` | 8x8 | No | ⬜ Not implemented |
| `ominous_spawning` | 8x8 | No | ⬜ Not implemented |

### Copper Particles
| Particle Type | Texture Size | Animated | Status |
|---------------|--------------|----------|--------|
| `copper_fire_flame` | 8x8 | No | ⬜ Not implemented |

---

## Blocks with Particle Effects

### Fire/Flame Blocks
| Block | Particles Used | State Condition | Status |
|-------|----------------|-----------------|--------|
| `torch` | flame, smoke | Always | ✅ Implemented |
| `wall_torch` | flame, smoke | Always | ✅ Implemented |
| `soul_torch` | soul_fire_flame, smoke | Always | ✅ Implemented |
| `soul_wall_torch` | soul_fire_flame, smoke | Always | ✅ Implemented |
| `redstone_torch` | dust (red) | When powered | ⬜ Partial (uses flame tinted) |
| `redstone_wall_torch` | dust (red) | When powered | ⬜ Partial (uses flame tinted) |
| `fire` | flame, lava, large_smoke | Always | ✅ Implemented |
| `soul_fire` | soul_fire_flame, large_smoke | Always | ✅ Implemented |
| `campfire` | flame, lava, smoke, campfire_cosy_smoke | lit=true | ✅ Implemented |
| `soul_campfire` | soul_fire_flame, smoke, campfire_signal_smoke | lit=true | ✅ Implemented |

### Furnace/Smelting Blocks
| Block | Particles Used | State Condition | Status |
|-------|----------------|-----------------|--------|
| `furnace` | flame, smoke | lit=true | ✅ Implemented |
| `blast_furnace` | flame, smoke | lit=true | ✅ Implemented |
| `smoker` | flame, smoke | lit=true | ✅ Implemented |

### Candles (17 variants)
| Block | Particles Used | State Condition | Status |
|-------|----------------|-----------------|--------|
| `candle` | small_flame, smoke | lit=true | ✅ Implemented |
| `white_candle` | small_flame, smoke | lit=true | ✅ Implemented |
| `orange_candle` | small_flame, smoke | lit=true | ✅ Implemented |
| `magenta_candle` | small_flame, smoke | lit=true | ✅ Implemented |
| `light_blue_candle` | small_flame, smoke | lit=true | ✅ Implemented |
| `yellow_candle` | small_flame, smoke | lit=true | ✅ Implemented |
| `lime_candle` | small_flame, smoke | lit=true | ✅ Implemented |
| `pink_candle` | small_flame, smoke | lit=true | ✅ Implemented |
| `gray_candle` | small_flame, smoke | lit=true | ✅ Implemented |
| `light_gray_candle` | small_flame, smoke | lit=true | ✅ Implemented |
| `cyan_candle` | small_flame, smoke | lit=true | ✅ Implemented |
| `purple_candle` | small_flame, smoke | lit=true | ✅ Implemented |
| `blue_candle` | small_flame, smoke | lit=true | ✅ Implemented |
| `brown_candle` | small_flame, smoke | lit=true | ✅ Implemented |
| `green_candle` | small_flame, smoke | lit=true | ✅ Implemented |
| `red_candle` | small_flame, smoke | lit=true | ✅ Implemented |
| `black_candle` | small_flame, smoke | lit=true | ✅ Implemented |
| `candle_cake` | small_flame, smoke | lit=true | ✅ Implemented |
| `*_candle_cake` (16 colors) | small_flame, smoke | lit=true | ✅ Implemented |

### Portal Blocks
| Block | Particles Used | State Condition | Status |
|-------|----------------|-----------------|--------|
| `nether_portal` | portal | Always | ✅ Implemented |
| `end_portal` | (special shader) | Always | ✅ Implemented |
| `end_gateway` | (special shader) | Always | ✅ Implemented |
| `respawn_anchor` | portal (reverse) | charge > 0 | ⬜ Partial (simplified) |

### Enchanting/Magic Blocks
| Block | Particles Used | State Condition | Status |
|-------|----------------|-----------------|--------|
| `enchanting_table` | enchant | Near bookshelves | ⬜ Partial (simplified sparkle) |
| `beacon` | (beam particles) | Active | ⬜ Partial (simplified) |
| `conduit` | nautilus, (effect) | Active | ⬜ Not implemented |
| `brewing_stand` | effect (purple) | Always | ⬜ Partial (simplified) |
| `ender_chest` | portal | Always | ✅ Implemented |

### Drip/Liquid Blocks
| Block | Particles Used | State Condition | Status |
|-------|----------------|-----------------|--------|
| `lava` | lava | Surface | ✅ Implemented |
| `pointed_dripstone` | dripping_water/lava, falling_*, landing_* | Has fluid above | ⬜ Not implemented |
| `wet_sponge` | dripping_water | In Nether | ⬜ Not implemented |
| `crying_obsidian` | dripping_obsidian_tear | Always | ✅ Implemented |
| `honey_block` | dripping_honey, falling_honey | Always | ⬜ Not implemented |
| `bubble_column` | bubble, bubble_column_up | In water | ⬜ Not implemented |

### Nature/Biome Blocks
| Block | Particles Used | State Condition | Status |
|-------|----------------|-----------------|--------|
| `spore_blossom` | spore_blossom_air, falling_spore_blossom | Always | ✅ Implemented |
| `mycelium` | mycelium | Random | ✅ Implemented |
| `cherry_leaves` | cherry_leaves | Random | ✅ Implemented |
| `pale_oak_leaves` | pale_oak_leaves | Random | ✅ Implemented |
| `azalea_leaves` | tinted_leaves | Random | ✅ Implemented |
| `flowering_azalea_leaves` | tinted_leaves | Random | ✅ Implemented |
| `oak_leaves` | tinted_leaves | Random | ✅ Implemented |
| `birch_leaves` | tinted_leaves | Random | ✅ Implemented |
| `spruce_leaves` | tinted_leaves | Random | ✅ Implemented |
| `jungle_leaves` | tinted_leaves | Random | ✅ Implemented |
| `acacia_leaves` | tinted_leaves | Random | ✅ Implemented |
| `dark_oak_leaves` | tinted_leaves | Random | ✅ Implemented |
| `mangrove_leaves` | tinted_leaves | Random | ✅ Implemented |
| `beehive` | falling_nectar | honey_level=5 | ⬜ Not implemented |
| `bee_nest` | falling_nectar | honey_level=5 | ⬜ Not implemented |

### Misc Ambient Blocks
| Block | Particles Used | State Condition | Status |
|-------|----------------|-----------------|--------|
| `end_rod` | end_rod | Always | ✅ Implemented |
| `note_block` | note | When played | ⬜ Not implemented |
| `composter` | composter | On use | ⬜ Not implemented |
| `dragon_egg` | portal | Always | ✅ Implemented |
| `wither_rose` | smoke | Random | ✅ Implemented |
| `lightning_rod` | electric_spark | When struck | ⬜ Not implemented |
| `firefly_bush` | firefly | Night time | ✅ Implemented (wandering behavior) |
| `powder_snow` | snowflake | Entities inside | ⬜ Not implemented |

### Redstone Blocks
| Block | Particles Used | State Condition | Status |
|-------|----------------|-----------------|--------|
| `redstone_wire` | dust (red) | power > 0 | ⬜ Not implemented |
| `redstone_ore` | dust (red) | lit=true | ⬜ Not implemented |
| `deepslate_redstone_ore` | dust (red) | lit=true | ⬜ Not implemented |

### Sculk Blocks
| Block | Particles Used | State Condition | Status |
|-------|----------------|-----------------|--------|
| `sculk_sensor` | sculk_charge, vibration | When activated | ⬜ Not implemented |
| `calibrated_sculk_sensor` | sculk_charge, vibration | When activated | ⬜ Not implemented |
| `sculk_shrieker` | shriek, sculk_soul | When activated | ⬜ Not implemented |
| `sculk_catalyst` | sculk_charge_pop | On mob death | ⬜ Not implemented |

### Falling Blocks (need special handling)
| Block | Particles Used | State Condition | Status |
|-------|----------------|-----------------|--------|
| `sand` | falling_dust | While falling | ⬜ Not implemented |
| `red_sand` | falling_dust | While falling | ⬜ Not implemented |
| `gravel` | falling_dust | While falling | ⬜ Not implemented |
| `concrete_powder (all)` | falling_dust | While falling | ⬜ Not implemented |

### Trial/Vault Blocks (1.21+)
| Block | Particles Used | State Condition | Status |
|-------|----------------|-----------------|--------|
| `trial_spawner` | trial_spawner_detection | When active | ⬜ Not implemented |
| `vault` | vault_connection | When connecting | ⬜ Not implemented |

---

## Implementation Difficulty Summary

### ✅ Completed (Config-only)
- Torches (all variants)
- Soul torches (all variants)
- Campfires (both variants)
- Furnaces (all variants)
- Candles (all 34 variants)
- End rods
- Lava surface
- Brewing stand (simplified)
- Enchanting table (simplified)
- Beacon (simplified)
- Respawn anchor (simplified)

### 🟡 Medium Effort (Minor code changes)
| Feature | Work Needed |
|---------|-------------|
| ~~Spore Blossom~~ | ~~Negative Y offset spawning, area effect~~ ✅ |
| Mycelium | Simple rising particle, random spawn |
| ~~Cherry Leaves~~ | ~~Random falling leaf particles~~ ✅ |
| Pale Oak Leaves | Random falling leaf particles |
| Crying Obsidian | Drip particle system (hang → fall → land) |
| Wet Sponge | Simple drip, Nether dimension check |
| Beehive/Bee Nest | Nectar drip when full |
| Wither Rose | Random smoke particles |
| Fire/Soul Fire | Flame + smoke + lava sparks |
| Ender Chest | Portal particles (swirl) |
| Dragon Egg | Portal particles |
| Firefly Bush | Firefly particles at night |

### 🔴 Hard Effort (Significant code changes)
| Feature | Work Needed |
|---------|-------------|
| Pointed Dripstone | Full drip lifecycle (hang → fall → land), fluid detection |
| Bubble Columns | Water detection, upward/downward currents |
| Nether Portal | Complex swirl pattern, 3D spawn box |
| Enchanting Table (full) | Orbiting particles from bookshelves |
| Note Block | Color based on pitch, bounce physics |
| Sculk Sensors/Shriekers | Event-driven activation, complex animations |
| Redstone Particles | Power level detection, dynamic spawning |
| Falling Blocks | Entity-based particle trails |
| Lightning Rod | Event-driven (lightning strike) |
| Weather Effects | Rain splash on surfaces, snow |

---

## Quick Stats
- **Total Particle Types**: ~100
- **Total Particle-Emitting Block Types**: ~60+
- **Implemented**: ~47 block variants (including spore blossom, all tinted leaves, cherry leaves)
- **Remaining**: ~13+ unique implementations needed

---

## Notes
- Many blocks share the same particle implementation (e.g., all colored candles use the same logic)
- Some particles require runtime data not available in static world files (e.g., redstone power level, sculk activation)
- Biome-specific particles (crimson spore, warped spore, basalt deltas ash) would require biome data
- Weather particles (rain, snow) require weather state which isn't in world files

---

## Non-Particle Block Effects

### Beacon Beams
| Feature | Status | Notes |
|---------|--------|-------|
| Basic beam rendering | ✅ Implemented | Two-layer beam (solid inner + glow outer) |
| Beam rotation animation | ✅ Implemented | 45°/sec rotation like Minecraft |
| Stained glass tinting | ✅ Implemented | All 16 colors supported |
| Color averaging | ✅ Implemented | Multiple stained glass blocks average colors |
| Beam blocking | ✅ Implemented | Opaque blocks stop beam |
| Beacon activation check | ✅ Implemented | Reads Levels from block entity data |

