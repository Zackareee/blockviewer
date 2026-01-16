# Block Rendering Support Analysis

Generated from debug_world.zip which contains every block type and state in Minecraft.

## Summary

| Category | Block Types | States | % of States | Renders? |
|----------|-------------|--------|-------------|----------|
| V3 WASM Mesher | 553 | 11397 | 38.4% | ✅ Yes |
| Block Entity Renderers | 157 | 2907 | 9.8% | ❌ No |
| Legacy Multipart | 91 | 12880 | 43.4% | ✅ Yes |
| Legacy Other | 45 | 469 | 1.6% | ✅ Yes |
| Greedy Mesher | 256 | 1817 | 6.1% | ✅ Yes |
| Unsupported | 61 | 198 | 0.7% | ❌ No |

## V3 WASM Model Mesher (553 blocks) ✅

These blocks have baked model geometry and are rendered by V3.

<details><summary>Click to expand</summary>

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
| end_portal_frame | 8 |
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
| piston_head | 24 |
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

## Block Entity Renderers (157 blocks) ❌

**These blocks have NO model geometry!** In Minecraft, they are rendered by special Java code (BlockEntityRenderer) that reads NBT data and draws custom 3D models. We do NOT support these.

| Block | States | Notes |
|-------|--------|-------|
| acacia_hanging_sign | 64 | Sign post/text |
| acacia_sign | 32 | Sign post/text |
| acacia_wall_hanging_sign | 8 | Sign post/text |
| acacia_wall_sign | 8 | Sign post/text |
| bamboo_hanging_sign | 64 | Sign post/text |
| bamboo_sign | 32 | Sign post/text |
| bamboo_wall_hanging_sign | 8 | Sign post/text |
| bamboo_wall_sign | 8 | Sign post/text |
| barrier | 2 |  |
| birch_hanging_sign | 64 | Sign post/text |
| birch_sign | 32 | Sign post/text |
| birch_wall_hanging_sign | 8 | Sign post/text |
| birch_wall_sign | 8 | Sign post/text |
| black_banner | 16 | Banner patterns |
| black_bed | 16 | 3D bed model |
| black_shulker_box | 6 | 3D shulker box |
| black_wall_banner | 4 | Banner patterns |
| blue_banner | 16 | Banner patterns |
| blue_bed | 16 | 3D bed model |
| blue_shulker_box | 6 | 3D shulker box |
| blue_wall_banner | 4 | Banner patterns |
| brown_banner | 16 | Banner patterns |
| brown_bed | 16 | 3D bed model |
| brown_shulker_box | 6 | 3D shulker box |
| brown_wall_banner | 4 | Banner patterns |
| bubble_column | 2 |  |
| cherry_hanging_sign | 64 | Sign post/text |
| cherry_sign | 32 | Sign post/text |
| cherry_wall_hanging_sign | 8 | Sign post/text |
| cherry_wall_sign | 8 | Sign post/text |
| chest | 24 | 3D chest with lid |
| conduit | 2 | Animated conduit |
| copper_chest | 24 | 3D chest with lid |
| copper_golem_statue | 32 |  |
| creeper_head | 32 | 3D skull/head model |
| creeper_wall_head | 8 | 3D skull/head model |
| crimson_hanging_sign | 64 | Sign post/text |
| crimson_sign | 32 | Sign post/text |
| crimson_wall_hanging_sign | 8 | Sign post/text |
| crimson_wall_sign | 8 | Sign post/text |
| cyan_banner | 16 | Banner patterns |
| cyan_bed | 16 | 3D bed model |
| cyan_shulker_box | 6 | 3D shulker box |
| cyan_wall_banner | 4 | Banner patterns |
| dark_oak_hanging_sign | 64 | Sign post/text |
| dark_oak_sign | 32 | Sign post/text |
| dark_oak_wall_hanging_sign | 8 | Sign post/text |
| dark_oak_wall_sign | 8 | Sign post/text |
| decorated_pot | 16 | Pot with sherds |
| dragon_head | 32 | 3D skull/head model |
| dragon_wall_head | 8 | 3D skull/head model |
| end_gateway | 1 | Portal effect |
| end_portal | 1 | Portal effect |
| ender_chest | 8 | 3D chest with lid |
| exposed_copper_chest | 24 | 3D chest with lid |
| exposed_copper_golem_statue | 32 |  |
| gray_banner | 16 | Banner patterns |
| gray_bed | 16 | 3D bed model |
| gray_shulker_box | 6 | 3D shulker box |
| gray_wall_banner | 4 | Banner patterns |
| green_banner | 16 | Banner patterns |
| green_bed | 16 | 3D bed model |
| green_shulker_box | 6 | 3D shulker box |
| green_wall_banner | 4 | Banner patterns |
| jungle_hanging_sign | 64 | Sign post/text |
| jungle_sign | 32 | Sign post/text |
| jungle_wall_hanging_sign | 8 | Sign post/text |
| jungle_wall_sign | 8 | Sign post/text |
| lava | 16 |  |
| light | 32 |  |
| light_blue_banner | 16 | Banner patterns |
| light_blue_bed | 16 | 3D bed model |
| light_blue_shulker_box | 6 | 3D shulker box |
| light_blue_wall_banner | 4 | Banner patterns |
| light_gray_banner | 16 | Banner patterns |
| light_gray_bed | 16 | 3D bed model |
| light_gray_shulker_box | 6 | 3D shulker box |
| light_gray_wall_banner | 4 | Banner patterns |
| lime_banner | 16 | Banner patterns |
| lime_bed | 16 | 3D bed model |
| lime_shulker_box | 6 | 3D shulker box |
| lime_wall_banner | 4 | Banner patterns |
| magenta_banner | 16 | Banner patterns |
| magenta_bed | 16 | 3D bed model |
| magenta_shulker_box | 6 | 3D shulker box |
| magenta_wall_banner | 4 | Banner patterns |
| mangrove_hanging_sign | 64 | Sign post/text |
| mangrove_sign | 32 | Sign post/text |
| mangrove_wall_hanging_sign | 8 | Sign post/text |
| mangrove_wall_sign | 8 | Sign post/text |
| moving_piston | 12 |  |
| oak_hanging_sign | 64 | Sign post/text |
| oak_sign | 32 | Sign post/text |
| oak_wall_hanging_sign | 8 | Sign post/text |
| oak_wall_sign | 8 | Sign post/text |
| orange_banner | 16 | Banner patterns |
| orange_bed | 16 | 3D bed model |
| orange_shulker_box | 6 | 3D shulker box |
| orange_wall_banner | 4 | Banner patterns |
| oxidized_copper_chest | 24 | 3D chest with lid |
| oxidized_copper_golem_statue | 32 |  |
| pale_oak_hanging_sign | 64 | Sign post/text |
| pale_oak_sign | 32 | Sign post/text |
| pale_oak_wall_hanging_sign | 8 | Sign post/text |
| pale_oak_wall_sign | 8 | Sign post/text |
| piglin_head | 32 | 3D skull/head model |
| piglin_wall_head | 8 | 3D skull/head model |
| pink_banner | 16 | Banner patterns |
| pink_bed | 16 | 3D bed model |
| pink_shulker_box | 6 | 3D shulker box |
| pink_wall_banner | 4 | Banner patterns |
| player_head | 32 | 3D skull/head model |
| player_wall_head | 8 | 3D skull/head model |
| purple_banner | 16 | Banner patterns |
| purple_bed | 16 | 3D bed model |
| purple_shulker_box | 6 | 3D shulker box |
| purple_wall_banner | 4 | Banner patterns |
| red_banner | 16 | Banner patterns |
| red_bed | 16 | 3D bed model |
| red_shulker_box | 6 | 3D shulker box |
| red_wall_banner | 4 | Banner patterns |
| shulker_box | 6 | 3D shulker box |
| skeleton_skull | 32 | 3D skull/head model |
| skeleton_wall_skull | 8 | 3D skull/head model |
| spruce_hanging_sign | 64 | Sign post/text |
| spruce_sign | 32 | Sign post/text |
| spruce_wall_hanging_sign | 8 | Sign post/text |
| spruce_wall_sign | 8 | Sign post/text |
| structure_void | 1 |  |
| trapped_chest | 24 | 3D chest with lid |
| warped_hanging_sign | 64 | Sign post/text |
| warped_sign | 32 | Sign post/text |
| warped_wall_hanging_sign | 8 | Sign post/text |
| warped_wall_sign | 8 | Sign post/text |
| water | 16 |  |
| waxed_copper_chest | 24 | 3D chest with lid |
| waxed_copper_golem_statue | 32 |  |
| waxed_exposed_copper_chest | 24 | 3D chest with lid |
| waxed_exposed_copper_golem_statue | 32 |  |
| waxed_oxidized_copper_chest | 24 | 3D chest with lid |
| waxed_oxidized_copper_golem_statue | 32 |  |
| waxed_weathered_copper_chest | 24 | 3D chest with lid |
| waxed_weathered_copper_golem_statue | 32 |  |
| weathered_copper_chest | 24 | 3D chest with lid |
| weathered_copper_golem_statue | 32 |  |
| white_banner | 16 | Banner patterns |
| white_bed | 16 | 3D bed model |
| white_shulker_box | 6 | 3D shulker box |
| white_wall_banner | 4 | Banner patterns |
| wither_skeleton_skull | 32 | 3D skull/head model |
| wither_skeleton_wall_skull | 8 | 3D skull/head model |
| yellow_banner | 16 | Banner patterns |
| yellow_bed | 16 | 3D bed model |
| yellow_shulker_box | 6 | 3D shulker box |
| yellow_wall_banner | 4 | Banner patterns |
| zombie_head | 32 | 3D skull/head model |
| zombie_wall_head | 8 | 3D skull/head model |

## Legacy Multipart Mesher (91 blocks) ✅

These blocks use multipart model composition and are handled by the legacy JS mesher.

<details><summary>Click to expand</summary>

| Block | States |
|-------|--------|
| acacia_fence | 32 |
| acacia_shelf | 64 |
| andesite_wall | 324 |
| bamboo | 12 |
| bamboo_fence | 32 |
| bamboo_shelf | 64 |
| birch_fence | 32 |
| birch_shelf | 64 |
| black_stained_glass_pane | 32 |
| blackstone_wall | 324 |
| blue_stained_glass_pane | 32 |
| bookshelf | 1 |
| brewing_stand | 8 |
| brick_wall | 324 |
| brown_mushroom_block | 64 |
| brown_stained_glass_pane | 32 |
| cherry_fence | 32 |
| cherry_shelf | 64 |
| chiseled_bookshelf | 256 |
| chorus_plant | 64 |
| cobbled_deepslate_wall | 324 |
| cobblestone_wall | 324 |
| copper_bars | 32 |
| crimson_fence | 32 |
| crimson_shelf | 64 |
| cyan_stained_glass_pane | 32 |
| dark_oak_fence | 32 |
| dark_oak_shelf | 64 |
| dead_fire_coral_block | 1 |
| deepslate_brick_wall | 324 |
| deepslate_tile_wall | 324 |
| diorite_wall | 324 |
| end_stone_brick_wall | 324 |
| exposed_copper_bars | 32 |
| fire | 512 |
| fire_coral_block | 1 |
| glass_pane | 32 |
| glow_lichen | 128 |
| granite_wall | 324 |
| gray_stained_glass_pane | 32 |
| green_stained_glass_pane | 32 |
| iron_bars | 32 |
| jungle_fence | 32 |
| jungle_shelf | 64 |
| light_blue_stained_glass_pane | 32 |
| light_gray_stained_glass_pane | 32 |
| lime_stained_glass_pane | 32 |
| magenta_stained_glass_pane | 32 |
| mangrove_fence | 32 |
| mangrove_shelf | 64 |
| mossy_cobblestone_wall | 324 |
| mossy_stone_brick_wall | 324 |
| mud_brick_wall | 324 |
| nether_brick_fence | 32 |
| nether_brick_wall | 324 |
| oak_fence | 32 |
| oak_shelf | 64 |
| orange_stained_glass_pane | 32 |
| oxidized_copper_bars | 32 |
| pale_oak_fence | 32 |
| pale_oak_shelf | 64 |
| pink_stained_glass_pane | 32 |
| polished_blackstone_brick_wall | 324 |
| polished_blackstone_wall | 324 |
| polished_deepslate_wall | 324 |
| polished_tuff_wall | 324 |
| prismarine_wall | 324 |
| purple_stained_glass_pane | 32 |
| red_mushroom_block | 64 |
| red_nether_brick_wall | 324 |
| red_sandstone_wall | 324 |
| red_stained_glass_pane | 32 |
| redstone_wire | 1296 |
| resin_brick_wall | 324 |
| sandstone_wall | 324 |
| soul_fire | 1 |
| spruce_fence | 32 |
| spruce_shelf | 64 |
| stone_brick_wall | 324 |
| tuff_brick_wall | 324 |
| tuff_wall | 324 |
| vine | 32 |
| warped_fence | 32 |
| warped_shelf | 64 |
| waxed_copper_bars | 32 |
| waxed_exposed_copper_bars | 32 |
| waxed_oxidized_copper_bars | 32 |
| waxed_weathered_copper_bars | 32 |
| weathered_copper_bars | 32 |
| white_stained_glass_pane | 32 |
| yellow_stained_glass_pane | 32 |
</details>

## Legacy Other Mesher (45 blocks) ✅

<details><summary>Click to expand</summary>

| Block | States |
|-------|--------|
| azalea_leaves | 28 |
| bamboo_block | 3 |
| bamboo_mosaic | 1 |
| bamboo_planks | 1 |
| black_stained_glass | 1 |
| blue_stained_glass | 1 |
| brown_stained_glass | 1 |
| composter | 9 |
| copper_grate | 2 |
| cyan_stained_glass | 1 |
| dried_kelp_block | 1 |
| exposed_copper_grate | 2 |
| flowering_azalea_leaves | 28 |
| glass | 1 |
| gray_stained_glass | 1 |
| green_stained_glass | 1 |
| leaf_litter | 16 |
| light_blue_stained_glass | 1 |
| light_gray_stained_glass | 1 |
| lime_stained_glass | 1 |
| lodestone | 1 |
| magenta_stained_glass | 1 |
| muddy_mangrove_roots | 3 |
| nether_wart_block | 1 |
| orange_stained_glass | 1 |
| oxidized_copper_grate | 2 |
| pale_moss_carpet | 162 |
| pink_petals | 16 |
| pink_stained_glass | 1 |
| purple_stained_glass | 1 |
| red_stained_glass | 1 |
| sculk_vein | 128 |
| sea_lantern | 1 |
| snow_block | 1 |
| stripped_bamboo_block | 3 |
| target | 16 |
| tinted_glass | 1 |
| waxed_copper_grate | 2 |
| waxed_exposed_copper_grate | 2 |
| waxed_oxidized_copper_grate | 2 |
| waxed_weathered_copper_grate | 2 |
| weathered_copper_grate | 2 |
| white_stained_glass | 1 |
| wildflowers | 16 |
| yellow_stained_glass | 1 |
</details>

## Greedy Mesher - Full Cubes (256 blocks) ✅

These are full cube blocks handled by the optimized greedy mesher.

<details><summary>Click to expand</summary>

| Block | States |
|-------|--------|
| acacia_leaves | 28 |
| acacia_log | 3 |
| acacia_planks | 1 |
| acacia_wood | 3 |
| amethyst_block | 1 |
| ancient_debris | 1 |
| andesite | 1 |
| basalt | 3 |
| bedrock | 1 |
| birch_leaves | 28 |
| birch_log | 3 |
| birch_planks | 1 |
| birch_wood | 3 |
| black_concrete | 1 |
| black_terracotta | 1 |
| black_wool | 1 |
| blackstone | 1 |
| blue_concrete | 1 |
| blue_terracotta | 1 |
| blue_wool | 1 |
| bone_block | 3 |
| brain_coral_block | 1 |
| brown_concrete | 1 |
| brown_terracotta | 1 |
| brown_wool | 1 |
| bubble_coral_block | 1 |
| calcite | 1 |
| cherry_leaves | 28 |
| cherry_log | 3 |
| cherry_planks | 1 |
| cherry_wood | 3 |
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
| copper_block | 1 |
| copper_ore | 1 |
| cracked_deepslate_bricks | 1 |
| cracked_deepslate_tiles | 1 |
| cracked_nether_bricks | 1 |
| cracked_polished_blackstone_bricks | 1 |
| cracked_stone_bricks | 1 |
| crimson_hyphae | 3 |
| crimson_planks | 1 |
| crimson_stem | 3 |
| crying_obsidian | 1 |
| cut_red_sandstone | 1 |
| cut_sandstone | 1 |
| cyan_concrete | 1 |
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
| dripstone_block | 1 |
| emerald_block | 1 |
| emerald_ore | 1 |
| end_stone | 1 |
| end_stone_bricks | 1 |
| gilded_blackstone | 1 |
| glowstone | 1 |
| gold_block | 1 |
| gold_ore | 1 |
| granite | 1 |
| grass_block | 2 |
| gravel | 1 |
| gray_concrete | 1 |
| gray_terracotta | 1 |
| gray_wool | 1 |
| green_concrete | 1 |
| green_terracotta | 1 |
| green_wool | 1 |
| hay_block | 3 |
| honeycomb_block | 1 |
| horn_coral_block | 1 |
| infested_chiseled_stone_bricks | 1 |
| infested_cobblestone | 1 |
| infested_cracked_stone_bricks | 1 |
| infested_deepslate | 3 |
| infested_mossy_stone_bricks | 1 |
| infested_stone | 1 |
| infested_stone_bricks | 1 |
| iron_block | 1 |
| iron_ore | 1 |
| jungle_leaves | 28 |
| jungle_log | 3 |
| jungle_planks | 1 |
| jungle_wood | 3 |
| lapis_block | 1 |
| lapis_ore | 1 |
| light_blue_concrete | 1 |
| light_blue_terracotta | 1 |
| light_blue_wool | 1 |
| light_gray_concrete | 1 |
| light_gray_terracotta | 1 |
| light_gray_wool | 1 |
| lime_concrete | 1 |
| lime_terracotta | 1 |
| lime_wool | 1 |
| magenta_concrete | 1 |
| magenta_terracotta | 1 |
| magenta_wool | 1 |
| magma_block | 1 |
| mangrove_leaves | 28 |
| mangrove_log | 3 |
| mangrove_planks | 1 |
| mangrove_wood | 3 |
| moss_block | 1 |
| mossy_cobblestone | 1 |
| mossy_stone_bricks | 1 |
| mud | 1 |
| mud_bricks | 1 |
| mushroom_stem | 64 |
| nether_bricks | 1 |
| nether_gold_ore | 1 |
| nether_quartz_ore | 1 |
| netherite_block | 1 |
| netherrack | 1 |
| note_block | 1150 |
| oak_leaves | 28 |
| oak_log | 3 |
| oak_planks | 1 |
| oak_wood | 3 |
| obsidian | 1 |
| orange_concrete | 1 |
| orange_terracotta | 1 |
| orange_wool | 1 |
| packed_mud | 1 |
| pale_moss_block | 1 |
| pale_oak_leaves | 28 |
| pale_oak_log | 3 |
| pale_oak_planks | 1 |
| pale_oak_wood | 3 |
| pink_concrete | 1 |
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
| purple_concrete | 1 |
| purple_terracotta | 1 |
| purple_wool | 1 |
| purpur_block | 1 |
| purpur_pillar | 3 |
| quartz_block | 1 |
| quartz_bricks | 1 |
| raw_copper_block | 1 |
| raw_gold_block | 1 |
| raw_iron_block | 1 |
| red_concrete | 1 |
| red_nether_bricks | 1 |
| red_sand | 1 |
| red_sandstone | 1 |
| red_terracotta | 1 |
| red_wool | 1 |
| redstone_block | 1 |
| redstone_lamp | 2 |
| redstone_ore | 2 |
| reinforced_deepslate | 1 |
| resin_block | 1 |
| resin_bricks | 1 |
| rooted_dirt | 1 |
| sand | 1 |
| sandstone | 1 |
| sculk | 1 |
| shroomlight | 1 |
| smooth_basalt | 1 |
| smooth_red_sandstone | 1 |
| smooth_sandstone | 1 |
| smooth_stone | 1 |
| soul_sand | 1 |
| soul_soil | 1 |
| spruce_leaves | 28 |
| spruce_log | 3 |
| spruce_planks | 1 |
| spruce_wood | 3 |
| stone | 1 |
| stone_bricks | 1 |
| stripped_acacia_log | 3 |
| stripped_acacia_wood | 3 |
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
| terracotta | 1 |
| test_instance_block | 1 |
| tube_coral_block | 1 |
| tuff | 1 |
| tuff_bricks | 1 |
| warped_hyphae | 3 |
| warped_planks | 1 |
| warped_stem | 3 |
| warped_wart_block | 1 |
| waxed_copper_block | 1 |
| white_concrete | 1 |
| white_terracotta | 1 |
| white_wool | 1 |
| yellow_concrete | 1 |
| yellow_terracotta | 1 |
| yellow_wool | 1 |
</details>

## Unsupported / Needs Review (61 blocks) ❌

| Block | States | Reason |
|-------|--------|--------|
| black_concrete_powder | 1 | Not categorized - needs review |
| blue_concrete_powder | 1 | Not categorized - needs review |
| blue_ice | 1 | Not categorized - needs review |
| bricks | 1 | Not categorized - needs review |
| brown_concrete_powder | 1 | Not categorized - needs review |
| budding_amethyst | 1 | Not categorized - needs review |
| cartography_table | 1 | Not categorized - needs review |
| chiseled_copper | 1 | Not categorized - needs review |
| crafting_table | 1 | Not categorized - needs review |
| crimson_nylium | 1 | Not categorized - needs review |
| cut_copper | 1 | Not categorized - needs review |
| cyan_concrete_powder | 1 | Not categorized - needs review |
| exposed_chiseled_copper | 1 | Not categorized - needs review |
| exposed_copper | 1 | Not categorized - needs review |
| exposed_cut_copper | 1 | Not categorized - needs review |
| fletching_table | 1 | Not categorized - needs review |
| gray_concrete_powder | 1 | Not categorized - needs review |
| green_concrete_powder | 1 | Not categorized - needs review |
| ice | 1 | Not categorized - needs review |
| jukebox | 2 | Not categorized - needs review |
| light_blue_concrete_powder | 1 | Not categorized - needs review |
| light_gray_concrete_powder | 1 | Not categorized - needs review |
| lime_concrete_powder | 1 | Not categorized - needs review |
| magenta_concrete_powder | 1 | Not categorized - needs review |
| melon | 1 | Not categorized - needs review |
| ochre_froglight | 3 | Not categorized - needs review |
| orange_concrete_powder | 1 | Not categorized - needs review |
| oxidized_chiseled_copper | 1 | Not categorized - needs review |
| oxidized_copper | 1 | Not categorized - needs review |
| oxidized_cut_copper | 1 | Not categorized - needs review |
| packed_ice | 1 | Not categorized - needs review |
| pearlescent_froglight | 3 | Not categorized - needs review |
| pink_concrete_powder | 1 | Not categorized - needs review |
| pumpkin | 1 | Not categorized - needs review |
| purple_concrete_powder | 1 | Not categorized - needs review |
| quartz_pillar | 3 | Not categorized - needs review |
| red_concrete_powder | 1 | Not categorized - needs review |
| resin_clump | 128 | Not categorized - needs review |
| smithing_table | 1 | Not categorized - needs review |
| smooth_quartz | 1 | Not categorized - needs review |
| sponge | 1 | Not categorized - needs review |
| tnt | 2 | Not categorized - needs review |
| verdant_froglight | 3 | Not categorized - needs review |
| warped_nylium | 1 | Not categorized - needs review |
| waxed_chiseled_copper | 1 | Not categorized - needs review |
| waxed_cut_copper | 1 | Not categorized - needs review |
| waxed_exposed_chiseled_copper | 1 | Not categorized - needs review |
| waxed_exposed_copper | 1 | Not categorized - needs review |
| waxed_exposed_cut_copper | 1 | Not categorized - needs review |
| waxed_oxidized_chiseled_copper | 1 | Not categorized - needs review |
| waxed_oxidized_copper | 1 | Not categorized - needs review |
| waxed_oxidized_cut_copper | 1 | Not categorized - needs review |
| waxed_weathered_chiseled_copper | 1 | Not categorized - needs review |
| waxed_weathered_copper | 1 | Not categorized - needs review |
| waxed_weathered_cut_copper | 1 | Not categorized - needs review |
| weathered_chiseled_copper | 1 | Not categorized - needs review |
| weathered_copper | 1 | Not categorized - needs review |
| weathered_cut_copper | 1 | Not categorized - needs review |
| wet_sponge | 1 | Not categorized - needs review |
| white_concrete_powder | 1 | Not categorized - needs review |
| yellow_concrete_powder | 1 | Not categorized - needs review |

## Block Entities

Block entities are blocks with extra NBT data (chests with contents, signs with text, etc.).
We parse the NBT but do NOT render the special visuals.

| Entity Type | Count | Visual Rendering |
|-------------|-------|------------------|
| hanging_sign | 864 | ❌ Not rendered |
| shelf | 768 | ❌ Not rendered |
| sign | 480 | ❌ Not rendered |
| calibrated_sculk_sensor | 384 | ❌ Not rendered |
| banner | 320 | ❌ Not rendered |
| skull | 280 | ❌ Not rendered |
| bed | 256 | ❌ Not rendered |
| chiseled_bookshelf | 256 | ❌ Not rendered |
| copper_golem_statue | 256 | ❌ Not rendered |
| chest | 216 | ❌ Not rendered |
| shulker_box | 102 | ❌ Not rendered |
| sculk_sensor | 96 | ❌ Not rendered |
| campfire | 64 | ❌ Not rendered |
| crafter | 48 | ❌ Not rendered |
| beehive | 48 | ❌ Not rendered |
| command_block | 36 | ❌ Not rendered |
| daylight_detector | 32 | ❌ Not rendered |
| bell | 32 | ❌ Not rendered |
| vault | 32 | ❌ Not rendered |
| trapped_chest | 24 | ❌ Not rendered |
| creaking_heart | 18 | ❌ Not rendered |
| comparator | 16 | ❌ Not rendered |
| lectern | 16 | ❌ Not rendered |
| decorated_pot | 16 | ❌ Not rendered |
| dispenser | 12 | ❌ Not rendered |
| trial_spawner | 12 | ❌ Not rendered |
| jigsaw | 12 | ❌ Not rendered |
| barrel | 12 | ❌ Not rendered |
| dropper | 12 | ❌ Not rendered |
| hopper | 10 | ❌ Not rendered |
| sculk_shrieker | 8 | ❌ Not rendered |
| ender_chest | 8 | ❌ Not rendered |
| brewing_stand | 8 | ❌ Not rendered |
| furnace | 8 | ❌ Not rendered |
| brushable_block | 8 | ❌ Not rendered |
| smoker | 8 | ❌ Not rendered |
| blast_furnace | 8 | ❌ Not rendered |
| structure_block | 4 | ❌ Not rendered |
| test_block | 4 | ❌ Not rendered |
| jukebox | 2 | ❌ Not rendered |
| sculk_catalyst | 2 | ❌ Not rendered |
| conduit | 2 | ❌ Not rendered |
| mob_spawner | 1 | ❌ Not rendered |
| enchanting_table | 1 | ❌ Not rendered |
| end_gateway | 1 | ✅ Not rendered |
| beacon | 1 | ❌ Not rendered |
| test_instance_block | 1 | ❌ Not rendered |
| end_portal | 1 | ✅ Not rendered |

## Entity Rendering

**Entities are NOT rendered.** This includes:
- Mobs (zombies, creepers, etc.)
- Item frames and paintings
- Armor stands
- Minecarts and boats
- Dropped items
- Projectiles
