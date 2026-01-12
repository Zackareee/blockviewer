# V3 Migration Coverage Analysis

Analysis of V3 meshing coverage for all Minecraft blocks.

## Executive Summary

| Metric | Blocks | States | % of Renderable |
|--------|--------|--------|-----------------|
| **V3 Native (no legacy)** | 912 | 13848 | 51.2% |
| Currently Rendered (V3 + Legacy) | 1003 | 26728 | 98.8% |
| Theoretical Max (excl. BER) | 1018 | 27065 | 100% |

### Target: 100% V3 Native



## Coverage by Category

| Category | Blocks | States | % States | Status |
|----------|--------|--------|----------|--------|
| V3 WASM Model Mesher | 551 | 11365 | 38.3% | ✅ V3 |
| Greedy Mesher (Full Cubes) | 361 | 2483 | 8.4% | ✅ V3 |
| Legacy Multipart | 91 | 12880 | 43.4% | ⚠️ Legacy |
| Block Entity Renderers | 145 | 2603 | 8.8% | ❌ No geometry |
| Unknown | 15 | 337 | 1.1% | ❓ Review |

## V3 WASM Model Mesher (551 blocks, 11365 states) ✅

Non-cube blocks with baked geometry, rendered entirely in WASM.

<details><summary>All 551 blocks</summary>

| Block | States |
|-------|--------|
| acacia_button | 24 |
| acacia_door | 64 |
| acacia_fence_gate | 32 |
| acacia_pressure_plate | 2 |
| acacia_sapling | 2 |
| acacia_slab | 6 |
| acacia_stairs | 80 |
| acacia_trapdoor | 64 |
| activator_rail | 24 |
| allium | 1 |
| amethyst_cluster | 12 |
| andesite_slab | 6 |
| andesite_stairs | 80 |
| anvil | 4 |
| attached_melon_stem | 4 |
| attached_pumpkin_stem | 4 |
| azalea | 1 |
| azure_bluet | 1 |
| bamboo_button | 24 |
| bamboo_door | 64 |
| bamboo_fence_gate | 32 |
| bamboo_mosaic_slab | 6 |
| bamboo_mosaic_stairs | 80 |
| bamboo_pressure_plate | 2 |
| bamboo_sapling | 1 |
| bamboo_slab | 6 |
| bamboo_stairs | 80 |
| bamboo_trapdoor | 64 |
| barrel | 12 |
| beacon | 1 |
| bee_nest | 24 |
| beehive | 24 |
| beetroots | 4 |
| bell | 32 |
| big_dripleaf | 32 |
| big_dripleaf_stem | 8 |
| birch_button | 24 |
| birch_door | 64 |
| birch_fence_gate | 32 |
| birch_pressure_plate | 2 |
| birch_sapling | 2 |
| birch_slab | 6 |
| birch_stairs | 80 |
| birch_trapdoor | 64 |
| black_candle | 16 |
| black_candle_cake | 2 |
| black_carpet | 1 |
| black_glazed_terracotta | 4 |
| blackstone_slab | 6 |
| blackstone_stairs | 80 |
| blast_furnace | 8 |
| blue_candle | 16 |
| blue_candle_cake | 2 |
| blue_carpet | 1 |
| blue_glazed_terracotta | 4 |
| blue_orchid | 1 |
| brain_coral | 2 |
| brain_coral_fan | 2 |
| brain_coral_wall_fan | 8 |
| brick_slab | 6 |
| brick_stairs | 80 |
| brown_candle | 16 |
| brown_candle_cake | 2 |
| brown_carpet | 1 |
| brown_glazed_terracotta | 4 |
| brown_mushroom | 1 |
| bubble_coral | 2 |
| bubble_coral_fan | 2 |
| bubble_coral_wall_fan | 8 |
| bush | 1 |
| cactus | 16 |
| cactus_flower | 1 |
| cake | 7 |
| calibrated_sculk_sensor | 384 |
| campfire | 32 |
| candle | 16 |
| candle_cake | 2 |
| carrots | 8 |
| carved_pumpkin | 4 |
| cauldron | 1 |
| cave_vines | 52 |
| cave_vines_plant | 2 |
| chain_command_block | 12 |
| cherry_button | 24 |
| cherry_door | 64 |
| cherry_fence_gate | 32 |
| cherry_pressure_plate | 2 |
| cherry_sapling | 2 |
| cherry_slab | 6 |
| cherry_stairs | 80 |
| cherry_trapdoor | 64 |
| chipped_anvil | 4 |
| chorus_flower | 6 |
| closed_eyeblossom | 1 |
| cobbled_deepslate_slab | 6 |
| cobbled_deepslate_stairs | 80 |
| cobblestone_slab | 6 |
| cobblestone_stairs | 80 |
| cobweb | 1 |
| cocoa | 12 |
| command_block | 12 |
| comparator | 16 |
| copper_bulb | 4 |
| copper_chain | 6 |
| copper_door | 64 |
| copper_lantern | 4 |
| copper_torch | 1 |
| copper_trapdoor | 64 |
| copper_wall_torch | 4 |
| cornflower | 1 |
| crafter | 48 |
| creaking_heart | 18 |
| crimson_button | 24 |
| crimson_door | 64 |
| crimson_fence_gate | 32 |
| crimson_fungus | 1 |
| crimson_pressure_plate | 2 |
| crimson_roots | 1 |
| crimson_slab | 6 |
| crimson_stairs | 80 |
| crimson_trapdoor | 64 |
| cut_copper_slab | 6 |
| cut_copper_stairs | 80 |
| cut_red_sandstone_slab | 6 |
| cut_sandstone_slab | 6 |
| cyan_candle | 16 |
| cyan_candle_cake | 2 |
| cyan_carpet | 1 |
| cyan_glazed_terracotta | 4 |
| damaged_anvil | 4 |
| dandelion | 1 |
| dark_oak_button | 24 |
| dark_oak_door | 64 |
| dark_oak_fence_gate | 32 |
| dark_oak_pressure_plate | 2 |
| dark_oak_sapling | 2 |
| dark_oak_slab | 6 |
| dark_oak_stairs | 80 |
| dark_oak_trapdoor | 64 |
| dark_prismarine_slab | 6 |
| dark_prismarine_stairs | 80 |
| daylight_detector | 32 |
| dead_brain_coral | 2 |
| dead_brain_coral_fan | 2 |
| dead_brain_coral_wall_fan | 8 |
| dead_bubble_coral | 2 |
| dead_bubble_coral_fan | 2 |
| dead_bubble_coral_wall_fan | 8 |
| dead_bush | 1 |
| dead_fire_coral | 2 |
| dead_fire_coral_fan | 2 |
| dead_fire_coral_wall_fan | 8 |
| dead_horn_coral | 2 |
| dead_horn_coral_fan | 2 |
| dead_horn_coral_wall_fan | 8 |
| dead_tube_coral | 2 |
| dead_tube_coral_fan | 2 |
| dead_tube_coral_wall_fan | 8 |
| deepslate_brick_slab | 6 |
| deepslate_brick_stairs | 80 |
| deepslate_tile_slab | 6 |
| deepslate_tile_stairs | 80 |
| detector_rail | 24 |
| diorite_slab | 6 |
| diorite_stairs | 80 |
| dirt_path | 1 |
| dispenser | 12 |
| dragon_egg | 1 |
| dried_ghast | 32 |
| dropper | 12 |
| enchanting_table | 1 |
| end_rod | 6 |
| end_stone_brick_slab | 6 |
| end_stone_brick_stairs | 80 |
| exposed_copper_bulb | 4 |
| exposed_copper_chain | 6 |
| exposed_copper_door | 64 |
| exposed_copper_lantern | 4 |
| exposed_copper_trapdoor | 64 |
| exposed_cut_copper_slab | 6 |
| exposed_cut_copper_stairs | 80 |
| exposed_lightning_rod | 24 |
| farmland | 8 |
| fern | 1 |
| fire_coral | 2 |
| fire_coral_fan | 2 |
| fire_coral_wall_fan | 8 |
| firefly_bush | 1 |
| flower_pot | 1 |
| flowering_azalea | 1 |
| frogspawn | 1 |
| frosted_ice | 4 |
| furnace | 8 |
| granite_slab | 6 |
| granite_stairs | 80 |
| gray_candle | 16 |
| gray_candle_cake | 2 |
| gray_carpet | 1 |
| gray_glazed_terracotta | 4 |
| green_candle | 16 |
| green_candle_cake | 2 |
| green_carpet | 1 |
| green_glazed_terracotta | 4 |
| grindstone | 12 |
| hanging_roots | 2 |
| heavy_core | 2 |
| heavy_weighted_pressure_plate | 16 |
| honey_block | 1 |
| hopper | 10 |
| horn_coral | 2 |
| horn_coral_fan | 2 |
| horn_coral_wall_fan | 8 |
| iron_chain | 6 |
| iron_door | 64 |
| iron_trapdoor | 64 |
| jack_o_lantern | 4 |
| jigsaw | 12 |
| jungle_button | 24 |
| jungle_door | 64 |
| jungle_fence_gate | 32 |
| jungle_pressure_plate | 2 |
| jungle_sapling | 2 |
| jungle_slab | 6 |
| jungle_stairs | 80 |
| jungle_trapdoor | 64 |
| kelp | 26 |
| kelp_plant | 1 |
| ladder | 8 |
| lantern | 4 |
| large_amethyst_bud | 12 |
| large_fern | 2 |
| lava_cauldron | 1 |
| lectern | 16 |
| lever | 24 |
| light_blue_candle | 16 |
| light_blue_candle_cake | 2 |
| light_blue_carpet | 1 |
| light_blue_glazed_terracotta | 4 |
| light_gray_candle | 16 |
| light_gray_candle_cake | 2 |
| light_gray_carpet | 1 |
| light_gray_glazed_terracotta | 4 |
| light_weighted_pressure_plate | 16 |
| lightning_rod | 24 |
| lilac | 2 |
| lily_of_the_valley | 1 |
| lily_pad | 1 |
| lime_candle | 16 |
| lime_candle_cake | 2 |
| lime_carpet | 1 |
| lime_glazed_terracotta | 4 |
| loom | 4 |
| magenta_candle | 16 |
| magenta_candle_cake | 2 |
| magenta_carpet | 1 |
| magenta_glazed_terracotta | 4 |
| mangrove_button | 24 |
| mangrove_door | 64 |
| mangrove_fence_gate | 32 |
| mangrove_pressure_plate | 2 |
| mangrove_propagule | 40 |
| mangrove_roots | 2 |
| mangrove_slab | 6 |
| mangrove_stairs | 80 |
| mangrove_trapdoor | 64 |
| medium_amethyst_bud | 12 |
| melon_stem | 8 |
| moss_carpet | 1 |
| mossy_cobblestone_slab | 6 |
| mossy_cobblestone_stairs | 80 |
| mossy_stone_brick_slab | 6 |
| mossy_stone_brick_stairs | 80 |
| mud_brick_slab | 6 |
| mud_brick_stairs | 80 |
| mycelium | 2 |
| nether_brick_slab | 6 |
| nether_brick_stairs | 80 |
| nether_portal | 2 |
| nether_sprouts | 1 |
| nether_wart | 4 |
| oak_button | 24 |
| oak_door | 64 |
| oak_fence_gate | 32 |
| oak_pressure_plate | 2 |
| oak_sapling | 2 |
| oak_slab | 6 |
| oak_stairs | 80 |
| oak_trapdoor | 64 |
| observer | 12 |
| open_eyeblossom | 1 |
| orange_candle | 16 |
| orange_candle_cake | 2 |
| orange_carpet | 1 |
| orange_glazed_terracotta | 4 |
| orange_tulip | 1 |
| oxeye_daisy | 1 |
| oxidized_copper_bulb | 4 |
| oxidized_copper_chain | 6 |
| oxidized_copper_door | 64 |
| oxidized_copper_lantern | 4 |
| oxidized_copper_trapdoor | 64 |
| oxidized_cut_copper_slab | 6 |
| oxidized_cut_copper_stairs | 80 |
| oxidized_lightning_rod | 24 |
| pale_hanging_moss | 2 |
| pale_oak_button | 24 |
| pale_oak_door | 64 |
| pale_oak_fence_gate | 32 |
| pale_oak_pressure_plate | 2 |
| pale_oak_sapling | 2 |
| pale_oak_slab | 6 |
| pale_oak_stairs | 80 |
| pale_oak_trapdoor | 64 |
| peony | 2 |
| petrified_oak_slab | 6 |
| pink_candle | 16 |
| pink_candle_cake | 2 |
| pink_carpet | 1 |
| pink_glazed_terracotta | 4 |
| pink_tulip | 1 |
| piston | 12 |
| pitcher_crop | 10 |
| pitcher_plant | 2 |
| podzol | 2 |
| pointed_dripstone | 20 |
| polished_andesite_slab | 6 |
| polished_andesite_stairs | 80 |
| polished_blackstone_brick_slab | 6 |
| polished_blackstone_brick_stairs | 80 |
| polished_blackstone_button | 24 |
| polished_blackstone_pressure_plate | 2 |
| polished_blackstone_slab | 6 |
| polished_blackstone_stairs | 80 |
| polished_deepslate_slab | 6 |
| polished_deepslate_stairs | 80 |
| polished_diorite_slab | 6 |
| polished_diorite_stairs | 80 |
| polished_granite_slab | 6 |
| polished_granite_stairs | 80 |
| polished_tuff_slab | 6 |
| polished_tuff_stairs | 80 |
| poppy | 1 |
| potatoes | 8 |
| potted_acacia_sapling | 1 |
| potted_allium | 1 |
| potted_azalea_bush | 1 |
| potted_azure_bluet | 1 |
| potted_bamboo | 1 |
| potted_birch_sapling | 1 |
| potted_blue_orchid | 1 |
| potted_brown_mushroom | 1 |
| potted_cactus | 1 |
| potted_cherry_sapling | 1 |
| potted_closed_eyeblossom | 1 |
| potted_cornflower | 1 |
| potted_crimson_fungus | 1 |
| potted_crimson_roots | 1 |
| potted_dandelion | 1 |
| potted_dark_oak_sapling | 1 |
| potted_dead_bush | 1 |
| potted_fern | 1 |
| potted_flowering_azalea_bush | 1 |
| potted_jungle_sapling | 1 |
| potted_lily_of_the_valley | 1 |
| potted_mangrove_propagule | 1 |
| potted_oak_sapling | 1 |
| potted_open_eyeblossom | 1 |
| potted_orange_tulip | 1 |
| potted_oxeye_daisy | 1 |
| potted_pale_oak_sapling | 1 |
| potted_pink_tulip | 1 |
| potted_poppy | 1 |
| potted_red_mushroom | 1 |
| potted_red_tulip | 1 |
| potted_spruce_sapling | 1 |
| potted_torchflower | 1 |
| potted_warped_fungus | 1 |
| potted_warped_roots | 1 |
| potted_white_tulip | 1 |
| potted_wither_rose | 1 |
| powder_snow | 1 |
| powder_snow_cauldron | 3 |
| powered_rail | 24 |
| prismarine_brick_slab | 6 |
| prismarine_brick_stairs | 80 |
| prismarine_slab | 6 |
| prismarine_stairs | 80 |
| pumpkin_stem | 8 |
| purple_candle | 16 |
| purple_candle_cake | 2 |
| purple_carpet | 1 |
| purple_glazed_terracotta | 4 |
| purpur_slab | 6 |
| purpur_stairs | 80 |
| quartz_slab | 6 |
| quartz_stairs | 80 |
| rail | 20 |
| red_candle | 16 |
| red_candle_cake | 2 |
| red_carpet | 1 |
| red_glazed_terracotta | 4 |
| red_mushroom | 1 |
| red_nether_brick_slab | 6 |
| red_nether_brick_stairs | 80 |
| red_sandstone_slab | 6 |
| red_sandstone_stairs | 80 |
| red_tulip | 1 |
| redstone_torch | 2 |
| redstone_wall_torch | 8 |
| repeater | 64 |
| repeating_command_block | 12 |
| resin_brick_slab | 6 |
| resin_brick_stairs | 80 |
| respawn_anchor | 5 |
| rose_bush | 2 |
| sandstone_slab | 6 |
| sandstone_stairs | 80 |
| scaffolding | 32 |
| sculk_catalyst | 2 |
| sculk_sensor | 96 |
| sculk_shrieker | 8 |
| sea_pickle | 8 |
| seagrass | 1 |
| short_dry_grass | 1 |
| short_grass | 1 |
| slime_block | 1 |
| small_amethyst_bud | 12 |
| small_dripleaf | 16 |
| smoker | 8 |
| smooth_quartz_slab | 6 |
| smooth_quartz_stairs | 80 |
| smooth_red_sandstone_slab | 6 |
| smooth_red_sandstone_stairs | 80 |
| smooth_sandstone_slab | 6 |
| smooth_sandstone_stairs | 80 |
| smooth_stone_slab | 6 |
| sniffer_egg | 3 |
| snow | 8 |
| soul_campfire | 32 |
| soul_lantern | 4 |
| soul_torch | 1 |
| soul_wall_torch | 4 |
| spawner | 1 |
| spore_blossom | 1 |
| spruce_button | 24 |
| spruce_door | 64 |
| spruce_fence_gate | 32 |
| spruce_pressure_plate | 2 |
| spruce_sapling | 2 |
| spruce_slab | 6 |
| spruce_stairs | 80 |
| spruce_trapdoor | 64 |
| sticky_piston | 12 |
| stone_brick_slab | 6 |
| stone_brick_stairs | 80 |
| stone_button | 24 |
| stone_pressure_plate | 2 |
| stone_slab | 6 |
| stone_stairs | 80 |
| stonecutter | 4 |
| structure_block | 4 |
| sugar_cane | 16 |
| sunflower | 2 |
| suspicious_gravel | 4 |
| suspicious_sand | 4 |
| sweet_berry_bush | 4 |
| tall_dry_grass | 1 |
| tall_grass | 2 |
| tall_seagrass | 2 |
| test_block | 4 |
| torch | 1 |
| torchflower | 1 |
| torchflower_crop | 2 |
| trial_spawner | 12 |
| tripwire | 128 |
| tripwire_hook | 16 |
| tube_coral | 2 |
| tube_coral_fan | 2 |
| tube_coral_wall_fan | 8 |
| tuff_brick_slab | 6 |
| tuff_brick_stairs | 80 |
| tuff_slab | 6 |
| tuff_stairs | 80 |
| turtle_egg | 12 |
| twisting_vines | 26 |
| twisting_vines_plant | 1 |
| vault | 32 |
| wall_torch | 4 |
| warped_button | 24 |
| warped_door | 64 |
| warped_fence_gate | 32 |
| warped_fungus | 1 |
| warped_pressure_plate | 2 |
| warped_roots | 1 |
| warped_slab | 6 |
| warped_stairs | 80 |
| warped_trapdoor | 64 |
| water_cauldron | 3 |
| waxed_copper_bulb | 4 |
| waxed_copper_chain | 6 |
| waxed_copper_door | 64 |
| waxed_copper_lantern | 4 |
| waxed_copper_trapdoor | 64 |
| waxed_cut_copper_slab | 6 |
| waxed_cut_copper_stairs | 80 |
| waxed_exposed_copper_bulb | 4 |
| waxed_exposed_copper_chain | 6 |
| waxed_exposed_copper_door | 64 |
| waxed_exposed_copper_lantern | 4 |
| waxed_exposed_copper_trapdoor | 64 |
| waxed_exposed_cut_copper_slab | 6 |
| waxed_exposed_cut_copper_stairs | 80 |
| waxed_exposed_lightning_rod | 24 |
| waxed_lightning_rod | 24 |
| waxed_oxidized_copper_bulb | 4 |
| waxed_oxidized_copper_chain | 6 |
| waxed_oxidized_copper_door | 64 |
| waxed_oxidized_copper_lantern | 4 |
| waxed_oxidized_copper_trapdoor | 64 |
| waxed_oxidized_cut_copper_slab | 6 |
| waxed_oxidized_cut_copper_stairs | 80 |
| waxed_oxidized_lightning_rod | 24 |
| waxed_weathered_copper_bulb | 4 |
| waxed_weathered_copper_chain | 6 |
| waxed_weathered_copper_door | 64 |
| waxed_weathered_copper_lantern | 4 |
| waxed_weathered_copper_trapdoor | 64 |
| waxed_weathered_cut_copper_slab | 6 |
| waxed_weathered_cut_copper_stairs | 80 |
| waxed_weathered_lightning_rod | 24 |
| weathered_copper_bulb | 4 |
| weathered_copper_chain | 6 |
| weathered_copper_door | 64 |
| weathered_copper_lantern | 4 |
| weathered_copper_trapdoor | 64 |
| weathered_cut_copper_slab | 6 |
| weathered_cut_copper_stairs | 80 |
| weathered_lightning_rod | 24 |
| weeping_vines | 26 |
| weeping_vines_plant | 1 |
| wheat | 8 |
| white_candle | 16 |
| white_candle_cake | 2 |
| white_carpet | 1 |
| white_glazed_terracotta | 4 |
| white_tulip | 1 |
| wither_rose | 1 |
| yellow_candle | 16 |
| yellow_candle_cake | 2 |
| yellow_carpet | 1 |
| yellow_glazed_terracotta | 4 |
</details>

## Greedy Mesher - Full Cubes (361 blocks, 2483 states) ✅

Optimized WASM greedy mesher for solid cube blocks.

<details><summary>All 361 blocks</summary>

| Block | States |
|-------|--------|
| acacia_leaves | 28 |
| acacia_log | 3 |
| acacia_planks | 1 |
| acacia_wood | 3 |
| amethyst_block | 1 |
| ancient_debris | 1 |
| andesite | 1 |
| azalea_leaves | 28 |
| bamboo_block | 3 |
| bamboo_mosaic | 1 |
| bamboo_planks | 1 |
| basalt | 3 |
| birch_leaves | 28 |
| birch_log | 3 |
| birch_planks | 1 |
| birch_wood | 3 |
| black_concrete | 1 |
| black_concrete_powder | 1 |
| black_stained_glass | 1 |
| black_terracotta | 1 |
| black_wool | 1 |
| blackstone | 1 |
| blue_concrete | 1 |
| blue_concrete_powder | 1 |
| blue_ice | 1 |
| blue_stained_glass | 1 |
| blue_terracotta | 1 |
| blue_wool | 1 |
| bone_block | 3 |
| brain_coral_block | 1 |
| bricks | 1 |
| brown_concrete | 1 |
| brown_concrete_powder | 1 |
| brown_stained_glass | 1 |
| brown_terracotta | 1 |
| brown_wool | 1 |
| bubble_coral_block | 1 |
| budding_amethyst | 1 |
| calcite | 1 |
| cartography_table | 1 |
| cherry_leaves | 28 |
| cherry_log | 3 |
| cherry_planks | 1 |
| cherry_wood | 3 |
| chiseled_copper | 1 |
| chiseled_deepslate | 1 |
| chiseled_nether_bricks | 1 |
| chiseled_polished_blackstone | 1 |
| chiseled_quartz_block | 1 |
| chiseled_red_sandstone | 1 |
| chiseled_resin_bricks | 1 |
| chiseled_sandstone | 1 |
| chiseled_stone_bricks | 1 |
| chiseled_tuff | 1 |
| chiseled_tuff_bricks | 1 |
| clay | 1 |
| coal_block | 1 |
| coal_ore | 1 |
| coarse_dirt | 1 |
| cobbled_deepslate | 1 |
| cobblestone | 1 |
| composter | 9 |
| copper_block | 1 |
| copper_grate | 2 |
| copper_ore | 1 |
| cracked_deepslate_bricks | 1 |
| cracked_deepslate_tiles | 1 |
| cracked_nether_bricks | 1 |
| cracked_polished_blackstone_bricks | 1 |
| cracked_stone_bricks | 1 |
| crafting_table | 1 |
| crimson_hyphae | 3 |
| crimson_nylium | 1 |
| crimson_planks | 1 |
| crimson_stem | 3 |
| crying_obsidian | 1 |
| cut_copper | 1 |
| cut_red_sandstone | 1 |
| cut_sandstone | 1 |
| cyan_concrete | 1 |
| cyan_concrete_powder | 1 |
| cyan_stained_glass | 1 |
| cyan_terracotta | 1 |
| cyan_wool | 1 |
| dark_oak_leaves | 28 |
| dark_oak_log | 3 |
| dark_oak_planks | 1 |
| dark_oak_wood | 3 |
| dark_prismarine | 1 |
| dead_brain_coral_block | 1 |
| dead_bubble_coral_block | 1 |
| dead_horn_coral_block | 1 |
| dead_tube_coral_block | 1 |
| deepslate | 3 |
| deepslate_bricks | 1 |
| deepslate_coal_ore | 1 |
| deepslate_copper_ore | 1 |
| deepslate_diamond_ore | 1 |
| deepslate_emerald_ore | 1 |
| deepslate_gold_ore | 1 |
| deepslate_iron_ore | 1 |
| deepslate_lapis_ore | 1 |
| deepslate_redstone_ore | 2 |
| deepslate_tiles | 1 |
| diamond_block | 1 |
| diamond_ore | 1 |
| diorite | 1 |
| dirt | 1 |
| dried_kelp_block | 1 |
| dripstone_block | 1 |
| emerald_block | 1 |
| emerald_ore | 1 |
| end_stone | 1 |
| end_stone_bricks | 1 |
| exposed_chiseled_copper | 1 |
| exposed_copper | 1 |
| exposed_copper_grate | 2 |
| exposed_cut_copper | 1 |
| fletching_table | 1 |
| flowering_azalea_leaves | 28 |
| gilded_blackstone | 1 |
| glass | 1 |
| glowstone | 1 |
| gold_block | 1 |
| gold_ore | 1 |
| granite | 1 |
| grass_block | 2 |
| gravel | 1 |
| gray_concrete | 1 |
| gray_concrete_powder | 1 |
| gray_stained_glass | 1 |
| gray_terracotta | 1 |
| gray_wool | 1 |
| green_concrete | 1 |
| green_concrete_powder | 1 |
| green_stained_glass | 1 |
| green_terracotta | 1 |
| green_wool | 1 |
| hay_block | 3 |
| honeycomb_block | 1 |
| horn_coral_block | 1 |
| ice | 1 |
| infested_chiseled_stone_bricks | 1 |
| infested_cobblestone | 1 |
| infested_cracked_stone_bricks | 1 |
| infested_deepslate | 3 |
| infested_mossy_stone_bricks | 1 |
| infested_stone | 1 |
| infested_stone_bricks | 1 |
| iron_block | 1 |
| iron_ore | 1 |
| jukebox | 2 |
| jungle_leaves | 28 |
| jungle_log | 3 |
| jungle_planks | 1 |
| jungle_wood | 3 |
| lapis_block | 1 |
| lapis_ore | 1 |
| leaf_litter | 16 |
| light_blue_concrete | 1 |
| light_blue_concrete_powder | 1 |
| light_blue_stained_glass | 1 |
| light_blue_terracotta | 1 |
| light_blue_wool | 1 |
| light_gray_concrete | 1 |
| light_gray_concrete_powder | 1 |
| light_gray_stained_glass | 1 |
| light_gray_terracotta | 1 |
| light_gray_wool | 1 |
| lime_concrete | 1 |
| lime_concrete_powder | 1 |
| lime_stained_glass | 1 |
| lime_terracotta | 1 |
| lime_wool | 1 |
| lodestone | 1 |
| magenta_concrete | 1 |
| magenta_concrete_powder | 1 |
| magenta_stained_glass | 1 |
| magenta_terracotta | 1 |
| magenta_wool | 1 |
| magma_block | 1 |
| mangrove_leaves | 28 |
| mangrove_log | 3 |
| mangrove_planks | 1 |
| mangrove_wood | 3 |
| melon | 1 |
| moss_block | 1 |
| mossy_cobblestone | 1 |
| mossy_stone_bricks | 1 |
| mud | 1 |
| mud_bricks | 1 |
| muddy_mangrove_roots | 3 |
| mushroom_stem | 64 |
| nether_bricks | 1 |
| nether_gold_ore | 1 |
| nether_quartz_ore | 1 |
| nether_wart_block | 1 |
| netherite_block | 1 |
| netherrack | 1 |
| note_block | 1150 |
| oak_leaves | 28 |
| oak_log | 3 |
| oak_planks | 1 |
| oak_wood | 3 |
| obsidian | 1 |
| ochre_froglight | 3 |
| orange_concrete | 1 |
| orange_concrete_powder | 1 |
| orange_stained_glass | 1 |
| orange_terracotta | 1 |
| orange_wool | 1 |
| oxidized_chiseled_copper | 1 |
| oxidized_copper | 1 |
| oxidized_copper_grate | 2 |
| oxidized_cut_copper | 1 |
| packed_ice | 1 |
| packed_mud | 1 |
| pale_moss_block | 1 |
| pale_moss_carpet | 162 |
| pale_oak_leaves | 28 |
| pale_oak_log | 3 |
| pale_oak_planks | 1 |
| pale_oak_wood | 3 |
| pearlescent_froglight | 3 |
| pink_concrete | 1 |
| pink_concrete_powder | 1 |
| pink_petals | 16 |
| pink_stained_glass | 1 |
| pink_terracotta | 1 |
| pink_wool | 1 |
| polished_andesite | 1 |
| polished_basalt | 3 |
| polished_blackstone | 1 |
| polished_blackstone_bricks | 1 |
| polished_deepslate | 1 |
| polished_diorite | 1 |
| polished_granite | 1 |
| polished_tuff | 1 |
| prismarine | 1 |
| prismarine_bricks | 1 |
| pumpkin | 1 |
| purple_concrete | 1 |
| purple_concrete_powder | 1 |
| purple_stained_glass | 1 |
| purple_terracotta | 1 |
| purple_wool | 1 |
| purpur_block | 1 |
| purpur_pillar | 3 |
| quartz_block | 1 |
| quartz_bricks | 1 |
| quartz_pillar | 3 |
| raw_copper_block | 1 |
| raw_gold_block | 1 |
| raw_iron_block | 1 |
| red_concrete | 1 |
| red_concrete_powder | 1 |
| red_nether_bricks | 1 |
| red_sand | 1 |
| red_sandstone | 1 |
| red_stained_glass | 1 |
| red_terracotta | 1 |
| red_wool | 1 |
| redstone_block | 1 |
| redstone_lamp | 2 |
| redstone_ore | 2 |
| reinforced_deepslate | 1 |
| resin_block | 1 |
| resin_bricks | 1 |
| resin_clump | 128 |
| rooted_dirt | 1 |
| sand | 1 |
| sandstone | 1 |
| sculk | 1 |
| sculk_vein | 128 |
| sea_lantern | 1 |
| shroomlight | 1 |
| smithing_table | 1 |
| smooth_basalt | 1 |
| smooth_quartz | 1 |
| smooth_red_sandstone | 1 |
| smooth_sandstone | 1 |
| smooth_stone | 1 |
| snow_block | 1 |
| soul_sand | 1 |
| soul_soil | 1 |
| sponge | 1 |
| spruce_leaves | 28 |
| spruce_log | 3 |
| spruce_planks | 1 |
| spruce_wood | 3 |
| stone | 1 |
| stone_bricks | 1 |
| stripped_acacia_log | 3 |
| stripped_acacia_wood | 3 |
| stripped_bamboo_block | 3 |
| stripped_birch_log | 3 |
| stripped_birch_wood | 3 |
| stripped_cherry_log | 3 |
| stripped_cherry_wood | 3 |
| stripped_crimson_hyphae | 3 |
| stripped_crimson_stem | 3 |
| stripped_dark_oak_log | 3 |
| stripped_dark_oak_wood | 3 |
| stripped_jungle_log | 3 |
| stripped_jungle_wood | 3 |
| stripped_mangrove_log | 3 |
| stripped_mangrove_wood | 3 |
| stripped_oak_log | 3 |
| stripped_oak_wood | 3 |
| stripped_pale_oak_log | 3 |
| stripped_pale_oak_wood | 3 |
| stripped_spruce_log | 3 |
| stripped_spruce_wood | 3 |
| stripped_warped_hyphae | 3 |
| stripped_warped_stem | 3 |
| target | 16 |
| terracotta | 1 |
| test_instance_block | 1 |
| tinted_glass | 1 |
| tnt | 2 |
| tube_coral_block | 1 |
| tuff | 1 |
| tuff_bricks | 1 |
| verdant_froglight | 3 |
| warped_hyphae | 3 |
| warped_nylium | 1 |
| warped_planks | 1 |
| warped_stem | 3 |
| warped_wart_block | 1 |
| waxed_chiseled_copper | 1 |
| waxed_copper_block | 1 |
| waxed_copper_grate | 2 |
| waxed_cut_copper | 1 |
| waxed_exposed_chiseled_copper | 1 |
| waxed_exposed_copper | 1 |
| waxed_exposed_copper_grate | 2 |
| waxed_exposed_cut_copper | 1 |
| waxed_oxidized_chiseled_copper | 1 |
| waxed_oxidized_copper | 1 |
| waxed_oxidized_copper_grate | 2 |
| waxed_oxidized_cut_copper | 1 |
| waxed_weathered_chiseled_copper | 1 |
| waxed_weathered_copper | 1 |
| waxed_weathered_copper_grate | 2 |
| waxed_weathered_cut_copper | 1 |
| weathered_chiseled_copper | 1 |
| weathered_copper | 1 |
| weathered_copper_grate | 2 |
| weathered_cut_copper | 1 |
| wet_sponge | 1 |
| white_concrete | 1 |
| white_concrete_powder | 1 |
| white_stained_glass | 1 |
| white_terracotta | 1 |
| white_wool | 1 |
| wildflowers | 16 |
| yellow_concrete | 1 |
| yellow_concrete_powder | 1 |
| yellow_stained_glass | 1 |
| yellow_terracotta | 1 |
| yellow_wool | 1 |
</details>

## Legacy Multipart - NEEDS V3 MIGRATION (91 blocks, 12880 states) ⚠️

**This is the main gap.** These blocks use multipart model composition.

### Migration Priority

#### Fences (13 blocks, 416 states)
Connection-based model (N/S/E/W connections)

| Block | States |
|-------|--------|
| acacia_fence | 32 |
| bamboo_fence | 32 |
| birch_fence | 32 |
| cherry_fence | 32 |
| crimson_fence | 32 |
| dark_oak_fence | 32 |
| jungle_fence | 32 |
| mangrove_fence | 32 |
| nether_brick_fence | 32 |
| oak_fence | 32 |
| pale_oak_fence | 32 |
| spruce_fence | 32 |
| warped_fence | 32 |

#### Walls (26 blocks, 8424 states)
Complex connections + post variants

| Block | States |
|-------|--------|
| andesite_wall | 324 |
| blackstone_wall | 324 |
| brick_wall | 324 |
| cobbled_deepslate_wall | 324 |
| cobblestone_wall | 324 |
| deepslate_brick_wall | 324 |
| deepslate_tile_wall | 324 |
| diorite_wall | 324 |
| end_stone_brick_wall | 324 |
| granite_wall | 324 |
| mossy_cobblestone_wall | 324 |
| mossy_stone_brick_wall | 324 |
| mud_brick_wall | 324 |
| nether_brick_wall | 324 |
| polished_blackstone_brick_wall | 324 |
| polished_blackstone_wall | 324 |
| polished_deepslate_wall | 324 |
| polished_tuff_wall | 324 |
| prismarine_wall | 324 |
| red_nether_brick_wall | 324 |
| red_sandstone_wall | 324 |
| resin_brick_wall | 324 |
| sandstone_wall | 324 |
| stone_brick_wall | 324 |
| tuff_brick_wall | 324 |
| tuff_wall | 324 |

#### Glass Panes (17 blocks, 544 states)
Connection-based

| Block | States |
|-------|--------|
| black_stained_glass_pane | 32 |
| blue_stained_glass_pane | 32 |
| brown_stained_glass_pane | 32 |
| cyan_stained_glass_pane | 32 |
| glass_pane | 32 |
| gray_stained_glass_pane | 32 |
| green_stained_glass_pane | 32 |
| light_blue_stained_glass_pane | 32 |
| light_gray_stained_glass_pane | 32 |
| lime_stained_glass_pane | 32 |
| magenta_stained_glass_pane | 32 |
| orange_stained_glass_pane | 32 |
| pink_stained_glass_pane | 32 |
| purple_stained_glass_pane | 32 |
| red_stained_glass_pane | 32 |
| white_stained_glass_pane | 32 |
| yellow_stained_glass_pane | 32 |

#### Iron/Copper Bars (9 blocks, 288 states)
Connection-based

| Block | States |
|-------|--------|
| copper_bars | 32 |
| exposed_copper_bars | 32 |
| iron_bars | 32 |
| oxidized_copper_bars | 32 |
| waxed_copper_bars | 32 |
| waxed_exposed_copper_bars | 32 |
| waxed_oxidized_copper_bars | 32 |
| waxed_weathered_copper_bars | 32 |
| weathered_copper_bars | 32 |

#### Redstone/Tripwire (1 blocks, 1296 states)
Power level + connections

| Block | States |
|-------|--------|
| redstone_wire | 1296 |

#### Fire (4 blocks, 515 states)
Multi-face attachment

| Block | States |
|-------|--------|
| dead_fire_coral_block | 1 |
| fire | 512 |
| fire_coral_block | 1 |
| soul_fire | 1 |

#### Mushroom Blocks (2 blocks, 128 states)
Per-face textures

| Block | States |
|-------|--------|
| brown_mushroom_block | 64 |
| red_mushroom_block | 64 |

#### Shelves/Bookshelves (14 blocks, 1025 states)
Slot-based models

| Block | States |
|-------|--------|
| acacia_shelf | 64 |
| bamboo_shelf | 64 |
| birch_shelf | 64 |
| bookshelf | 1 |
| cherry_shelf | 64 |
| chiseled_bookshelf | 256 |
| crimson_shelf | 64 |
| dark_oak_shelf | 64 |
| jungle_shelf | 64 |
| mangrove_shelf | 64 |
| oak_shelf | 64 |
| pale_oak_shelf | 64 |
| spruce_shelf | 64 |
| warped_shelf | 64 |

#### Other (5 blocks, 244 states)
Vines, chorus, etc.

| Block | States |
|-------|--------|
| bamboo | 12 |
| brewing_stand | 8 |
| chorus_plant | 64 |
| glow_lichen | 128 |
| vine | 32 |


## Block Entity Renderers - NOT RENDERABLE (145 blocks, 2603 states) ❌

These have **no model geometry**. Minecraft uses Java code to draw them.
To support these, we'd need custom 3D model implementations for each type.

| Type | Blocks | States |
|------|--------|--------|
| Signs (all types) | 48 | 1344 |
| Banners | 32 | 320 |
| Heads/Skulls | 15 | 304 |
| Beds | 17 | 257 |
| Chests | 11 | 248 |
| Shulker Boxes | 17 | 102 |
| Other | 5 | 28 |

## Unknown Blocks - NEEDS REVIEW (15 blocks, 337 states) ❓

| Block | States | Notes |
|-------|--------|-------|
| barrier | 2 | Invisible block |
| bubble_column | 2 | Particle effect only |
| copper_golem_statue | 32 | Custom entity statue |
| exposed_copper_golem_statue | 32 | Custom entity statue |
| lava | 16 | Fluid - special renderer needed |
| light | 32 | Invisible block |
| moving_piston | 12 | Animated block entity |
| oxidized_copper_golem_statue | 32 | Custom entity statue |
| structure_void | 1 | Invisible block |
| water | 16 | Fluid - special renderer needed |
| waxed_copper_golem_statue | 32 | Custom entity statue |
| waxed_exposed_copper_golem_statue | 32 | Custom entity statue |
| waxed_oxidized_copper_golem_statue | 32 | Custom entity statue |
| waxed_weathered_copper_golem_statue | 32 | Custom entity statue |
| weathered_copper_golem_statue | 32 | Custom entity statue |

## V3 Migration Roadmap

### Phase 1: Multipart Blocks (High Impact)
- **Target:** 12880 states (47.6% of renderable)
- Implement multipart model resolution in WASM
- Connection-based geometry composition

### Phase 2: Edge Cases
- Fluids (water, lava) - 14 states
- Moving piston - special case

### Not Planned (Block Entity Renderers)
- 145 blocks with no model geometry
- Would require custom 3D model implementations
- Low priority unless specifically requested
