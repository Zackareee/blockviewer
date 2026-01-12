# Block Rendering Support Analysis

Generated from debug_world.zip which contains every block type and state in Minecraft.

## Summary

| Category | Block Types | States | % of States |
|----------|-------------|--------|-------------|
| V3 WASM Mesher | 710 | 14304 | 48.2% |
| Legacy Multipart | 91 | 12880 | 43.4% |
| Legacy Other | 46 | 470 | 1.6% |
| Greedy Mesher | 255 | 1816 | 6.1% |
| Unsupported/Review | 61 | 198 | 0.7% |

## V3 WASM Model Mesher (710 blocks)

These blocks are handled by the new V3 WASM-based model mesher.

| Block | States | Sample Properties |
|-------|--------|-------------------|
| acacia_button | 24 | face=ceiling, powered=false, facing=east |
| acacia_door | 64 | hinge=left, half=lower, powered=false, facing=east |
| acacia_fence_gate | 32 | in_wall=false, powered=false, facing=east, open=fa |
| acacia_hanging_sign | 64 | waterlogged=false, rotation=0, attached=false |
| acacia_pressure_plate | 2 | powered=false |
| acacia_sapling | 2 | stage=0 |
| acacia_sign | 32 | waterlogged=false, rotation=0 |
| acacia_slab | 6 | waterlogged=false, type=bottom |
| acacia_stairs | 80 | waterlogged=false, half=bottom, shape=inner_left,  |
| acacia_trapdoor | 64 | waterlogged=false, half=bottom, powered=false, fac |
| acacia_wall_hanging_sign | 8 | waterlogged=false, facing=east |
| acacia_wall_sign | 8 | waterlogged=false, facing=east |
| activator_rail | 24 | waterlogged=false, shape=ascending_east, powered=f |
| allium | 1 | - |
| amethyst_cluster | 12 | waterlogged=false, facing=down |
| andesite_slab | 6 | waterlogged=false, type=bottom |
| andesite_stairs | 80 | waterlogged=false, half=bottom, shape=inner_left,  |
| anvil | 4 | facing=east |
| attached_melon_stem | 4 | facing=east |
| attached_pumpkin_stem | 4 | facing=east |
| azalea | 1 | - |
| azure_bluet | 1 | - |
| bamboo_button | 24 | face=ceiling, powered=false, facing=east |
| bamboo_door | 64 | hinge=left, half=lower, powered=false, facing=east |
| bamboo_fence_gate | 32 | in_wall=false, powered=false, facing=east, open=fa |
| bamboo_hanging_sign | 64 | waterlogged=false, rotation=0, attached=false |
| bamboo_mosaic_slab | 6 | waterlogged=false, type=bottom |
| bamboo_mosaic_stairs | 80 | waterlogged=false, half=bottom, shape=inner_left,  |
| bamboo_pressure_plate | 2 | powered=false |
| bamboo_sapling | 1 | - |
| bamboo_sign | 32 | waterlogged=false, rotation=0 |
| bamboo_slab | 6 | waterlogged=false, type=bottom |
| bamboo_stairs | 80 | waterlogged=false, half=bottom, shape=inner_left,  |
| bamboo_trapdoor | 64 | waterlogged=false, half=bottom, powered=false, fac |
| bamboo_wall_hanging_sign | 8 | waterlogged=false, facing=east |
| bamboo_wall_sign | 8 | waterlogged=false, facing=east |
| barrel | 12 | facing=down, open=false |
| barrier | 2 | waterlogged=false |
| beacon | 1 | - |
| bee_nest | 24 | facing=east, honey_level=0 |
| beehive | 24 | facing=east, honey_level=0 |
| beetroots | 4 | age=0 |
| bell | 32 | powered=false, attachment=ceiling, facing=east |
| big_dripleaf | 32 | waterlogged=false, facing=east, tilt=full |
| big_dripleaf_stem | 8 | waterlogged=false, facing=east |
| birch_button | 24 | face=ceiling, powered=false, facing=east |
| birch_door | 64 | hinge=left, half=lower, powered=false, facing=east |
| birch_fence_gate | 32 | in_wall=false, powered=false, facing=east, open=fa |
| birch_hanging_sign | 64 | waterlogged=false, rotation=0, attached=false |
| birch_pressure_plate | 2 | powered=false |
| ... | ... | (660 more blocks) |

## Legacy Multipart Mesher (91 blocks)

These blocks use multipart model composition and are handled by the legacy JS mesher.

| Block | States | Sample Properties |
|-------|--------|-------------------|
| acacia_fence | 32 | east=false, waterlogged=false, south=false, north= |
| acacia_shelf | 64 | waterlogged=false, side_chain=center, powered=fals |
| andesite_wall | 324 | east=low, waterlogged=false, south=low, north=low, |
| bamboo | 12 | stage=0, leaves=large, age=0 |
| bamboo_fence | 32 | east=false, waterlogged=false, south=false, north= |
| bamboo_shelf | 64 | waterlogged=false, side_chain=center, powered=fals |
| birch_fence | 32 | east=false, waterlogged=false, south=false, north= |
| birch_shelf | 64 | waterlogged=false, side_chain=center, powered=fals |
| black_stained_glass_pane | 32 | east=false, waterlogged=false, south=false, north= |
| blackstone_wall | 324 | east=low, waterlogged=false, south=low, north=low, |
| blue_stained_glass_pane | 32 | east=false, waterlogged=false, south=false, north= |
| bookshelf | 1 | - |
| brewing_stand | 8 | has_bottle_0=false, has_bottle_1=false, has_bottle |
| brick_wall | 324 | east=low, waterlogged=false, south=low, north=low, |
| brown_mushroom_block | 64 | east=false, south=false, north=false, west=false,  |
| brown_stained_glass_pane | 32 | east=false, waterlogged=false, south=false, north= |
| cherry_fence | 32 | east=false, waterlogged=false, south=false, north= |
| cherry_shelf | 64 | waterlogged=false, side_chain=center, powered=fals |
| chiseled_bookshelf | 256 | slot_2_occupied=false, slot_5_occupied=false, slot |
| chorus_plant | 64 | east=false, south=false, north=false, west=false,  |
| cobbled_deepslate_wall | 324 | east=low, waterlogged=false, south=low, north=low, |
| cobblestone_wall | 324 | east=low, waterlogged=false, south=low, north=low, |
| copper_bars | 32 | east=false, waterlogged=false, south=false, north= |
| crimson_fence | 32 | east=false, waterlogged=false, south=false, north= |
| crimson_shelf | 64 | waterlogged=false, side_chain=center, powered=fals |
| cyan_stained_glass_pane | 32 | east=false, waterlogged=false, south=false, north= |
| dark_oak_fence | 32 | east=false, waterlogged=false, south=false, north= |
| dark_oak_shelf | 64 | waterlogged=false, side_chain=center, powered=fals |
| dead_fire_coral_block | 1 | - |
| deepslate_brick_wall | 324 | east=low, waterlogged=false, south=low, north=low, |
| deepslate_tile_wall | 324 | east=low, waterlogged=false, south=low, north=low, |
| diorite_wall | 324 | east=low, waterlogged=false, south=low, north=low, |
| end_stone_brick_wall | 324 | east=low, waterlogged=false, south=low, north=low, |
| exposed_copper_bars | 32 | east=false, waterlogged=false, south=false, north= |
| fire | 512 | east=false, south=false, north=false, west=false,  |
| fire_coral_block | 1 | - |
| glass_pane | 32 | east=false, waterlogged=false, south=false, north= |
| glow_lichen | 128 | east=false, waterlogged=false, south=false, north= |
| granite_wall | 324 | east=low, waterlogged=false, south=low, north=low, |
| gray_stained_glass_pane | 32 | east=false, waterlogged=false, south=false, north= |
| green_stained_glass_pane | 32 | east=false, waterlogged=false, south=false, north= |
| iron_bars | 32 | east=false, waterlogged=false, south=false, north= |
| jungle_fence | 32 | east=false, waterlogged=false, south=false, north= |
| jungle_shelf | 64 | waterlogged=false, side_chain=center, powered=fals |
| light_blue_stained_glass_pane | 32 | east=false, waterlogged=false, south=false, north= |
| light_gray_stained_glass_pane | 32 | east=false, waterlogged=false, south=false, north= |
| lime_stained_glass_pane | 32 | east=false, waterlogged=false, south=false, north= |
| magenta_stained_glass_pane | 32 | east=false, waterlogged=false, south=false, north= |
| mangrove_fence | 32 | east=false, waterlogged=false, south=false, north= |
| mangrove_shelf | 64 | waterlogged=false, side_chain=center, powered=fals |
| mossy_cobblestone_wall | 324 | east=low, waterlogged=false, south=low, north=low, |
| mossy_stone_brick_wall | 324 | east=low, waterlogged=false, south=low, north=low, |
| mud_brick_wall | 324 | east=low, waterlogged=false, south=low, north=low, |
| nether_brick_fence | 32 | east=false, waterlogged=false, south=false, north= |
| nether_brick_wall | 324 | east=low, waterlogged=false, south=low, north=low, |
| oak_fence | 32 | east=false, waterlogged=false, south=false, north= |
| oak_shelf | 64 | waterlogged=false, side_chain=center, powered=fals |
| orange_stained_glass_pane | 32 | east=false, waterlogged=false, south=false, north= |
| oxidized_copper_bars | 32 | east=false, waterlogged=false, south=false, north= |
| pale_oak_fence | 32 | east=false, waterlogged=false, south=false, north= |
| pale_oak_shelf | 64 | waterlogged=false, side_chain=center, powered=fals |
| pink_stained_glass_pane | 32 | east=false, waterlogged=false, south=false, north= |
| polished_blackstone_brick_wall | 324 | east=low, waterlogged=false, south=low, north=low, |
| polished_blackstone_wall | 324 | east=low, waterlogged=false, south=low, north=low, |
| polished_deepslate_wall | 324 | east=low, waterlogged=false, south=low, north=low, |
| polished_tuff_wall | 324 | east=low, waterlogged=false, south=low, north=low, |
| prismarine_wall | 324 | east=low, waterlogged=false, south=low, north=low, |
| purple_stained_glass_pane | 32 | east=false, waterlogged=false, south=false, north= |
| red_mushroom_block | 64 | east=false, south=false, north=false, west=false,  |
| red_nether_brick_wall | 324 | east=low, waterlogged=false, south=low, north=low, |
| red_sandstone_wall | 324 | east=low, waterlogged=false, south=low, north=low, |
| red_stained_glass_pane | 32 | east=false, waterlogged=false, south=false, north= |
| redstone_wire | 1296 | east=none, south=none, north=none, west=none, powe |
| resin_brick_wall | 324 | east=low, waterlogged=false, south=low, north=low, |
| sandstone_wall | 324 | east=low, waterlogged=false, south=low, north=low, |
| soul_fire | 1 | - |
| spruce_fence | 32 | east=false, waterlogged=false, south=false, north= |
| spruce_shelf | 64 | waterlogged=false, side_chain=center, powered=fals |
| stone_brick_wall | 324 | east=low, waterlogged=false, south=low, north=low, |
| tuff_brick_wall | 324 | east=low, waterlogged=false, south=low, north=low, |
| tuff_wall | 324 | east=low, waterlogged=false, south=low, north=low, |
| vine | 32 | east=false, south=false, north=false, west=false,  |
| warped_fence | 32 | east=false, waterlogged=false, south=false, north= |
| warped_shelf | 64 | waterlogged=false, side_chain=center, powered=fals |
| waxed_copper_bars | 32 | east=false, waterlogged=false, south=false, north= |
| waxed_exposed_copper_bars | 32 | east=false, waterlogged=false, south=false, north= |
| waxed_oxidized_copper_bars | 32 | east=false, waterlogged=false, south=false, north= |
| waxed_weathered_copper_bars | 32 | east=false, waterlogged=false, south=false, north= |
| weathered_copper_bars | 32 | east=false, waterlogged=false, south=false, north= |
| white_stained_glass_pane | 32 | east=false, waterlogged=false, south=false, north= |
| yellow_stained_glass_pane | 32 | east=false, waterlogged=false, south=false, north= |

## Legacy Other Mesher (46 blocks)

These blocks match legacy ModelMesher patterns.

| Block | States | Sample Properties |
|-------|--------|-------------------|
| azalea_leaves | 28 | waterlogged=false, distance=1, persistent=false |
| bamboo_block | 3 | axis=x |
| bamboo_mosaic | 1 | - |
| bamboo_planks | 1 | - |
| bedrock | 1 | - |
| black_stained_glass | 1 | - |
| blue_stained_glass | 1 | - |
| brown_stained_glass | 1 | - |
| composter | 9 | level=0 |
| copper_grate | 2 | waterlogged=false |
| cyan_stained_glass | 1 | - |
| dried_kelp_block | 1 | - |
| exposed_copper_grate | 2 | waterlogged=false |
| flowering_azalea_leaves | 28 | waterlogged=false, distance=1, persistent=false |
| glass | 1 | - |
| gray_stained_glass | 1 | - |
| green_stained_glass | 1 | - |
| leaf_litter | 16 | segment_amount=1, facing=east |
| light_blue_stained_glass | 1 | - |
| light_gray_stained_glass | 1 | - |
| lime_stained_glass | 1 | - |
| lodestone | 1 | - |
| magenta_stained_glass | 1 | - |
| muddy_mangrove_roots | 3 | axis=x |
| nether_wart_block | 1 | - |
| orange_stained_glass | 1 | - |
| oxidized_copper_grate | 2 | waterlogged=false |
| pale_moss_carpet | 162 | east=low, south=low, bottom=false, north=low, west |
| pink_petals | 16 | facing=east, flower_amount=1 |
| pink_stained_glass | 1 | - |
| purple_stained_glass | 1 | - |
| red_stained_glass | 1 | - |
| sculk_vein | 128 | east=false, waterlogged=false, south=false, north= |
| sea_lantern | 1 | - |
| snow_block | 1 | - |
| stripped_bamboo_block | 3 | axis=x |
| target | 16 | power=0 |
| tinted_glass | 1 | - |
| waxed_copper_grate | 2 | waterlogged=false |
| waxed_exposed_copper_grate | 2 | waterlogged=false |
| waxed_oxidized_copper_grate | 2 | waterlogged=false |
| waxed_weathered_copper_grate | 2 | waterlogged=false |
| weathered_copper_grate | 2 | waterlogged=false |
| white_stained_glass | 1 | - |
| wildflowers | 16 | facing=east, flower_amount=1 |
| yellow_stained_glass | 1 | - |

## Greedy Mesher - Full Cubes (255 blocks)

These are full cube blocks handled by the optimized greedy mesher.

| Block | States | Reason |
|-------|--------|--------|
| acacia_leaves | 28 | Full cube (greedy mesher) |
| acacia_log | 3 | Full cube (greedy mesher) |
| acacia_planks | 1 | Full cube (greedy mesher) |
| acacia_wood | 3 | Full cube (greedy mesher) |
| amethyst_block | 1 | Full cube (greedy mesher) |
| ancient_debris | 1 | Full cube (greedy mesher) |
| andesite | 1 | Full cube (greedy mesher) |
| basalt | 3 | Full cube (greedy mesher) |
| birch_leaves | 28 | Full cube (greedy mesher) |
| birch_log | 3 | Full cube (greedy mesher) |
| birch_planks | 1 | Full cube (greedy mesher) |
| birch_wood | 3 | Full cube (greedy mesher) |
| black_concrete | 1 | Full cube (greedy mesher) |
| black_terracotta | 1 | Full cube (greedy mesher) |
| black_wool | 1 | Full cube (greedy mesher) |
| blackstone | 1 | Full cube (greedy mesher) |
| blue_concrete | 1 | Full cube (greedy mesher) |
| blue_terracotta | 1 | Full cube (greedy mesher) |
| blue_wool | 1 | Full cube (greedy mesher) |
| bone_block | 3 | Full cube (greedy mesher) |
| brain_coral_block | 1 | Full cube (greedy mesher) |
| brown_concrete | 1 | Full cube (greedy mesher) |
| brown_terracotta | 1 | Full cube (greedy mesher) |
| brown_wool | 1 | Full cube (greedy mesher) |
| bubble_coral_block | 1 | Full cube (greedy mesher) |
| calcite | 1 | Full cube (greedy mesher) |
| cherry_leaves | 28 | Full cube (greedy mesher) |
| cherry_log | 3 | Full cube (greedy mesher) |
| cherry_planks | 1 | Full cube (greedy mesher) |
| cherry_wood | 3 | Full cube (greedy mesher) |
| chiseled_deepslate | 1 | Full cube (greedy mesher) |
| chiseled_nether_bricks | 1 | Full cube (greedy mesher) |
| chiseled_polished_blackstone | 1 | Full cube (greedy mesher) |
| chiseled_quartz_block | 1 | Full cube (greedy mesher) |
| chiseled_red_sandstone | 1 | Full cube (greedy mesher) |
| chiseled_resin_bricks | 1 | Full cube (greedy mesher) |
| chiseled_sandstone | 1 | Full cube (greedy mesher) |
| chiseled_stone_bricks | 1 | Full cube (greedy mesher) |
| chiseled_tuff | 1 | Full cube (greedy mesher) |
| chiseled_tuff_bricks | 1 | Full cube (greedy mesher) |
| clay | 1 | Full cube (greedy mesher) |
| coal_block | 1 | Full cube (greedy mesher) |
| coal_ore | 1 | Full cube (greedy mesher) |
| coarse_dirt | 1 | Full cube (greedy mesher) |
| cobbled_deepslate | 1 | Full cube (greedy mesher) |
| cobblestone | 1 | Full cube (greedy mesher) |
| copper_block | 1 | Full cube (greedy mesher) |
| copper_ore | 1 | Full cube (greedy mesher) |
| cracked_deepslate_bricks | 1 | Full cube (greedy mesher) |
| cracked_deepslate_tiles | 1 | Full cube (greedy mesher) |
| cracked_nether_bricks | 1 | Full cube (greedy mesher) |
| cracked_polished_blackstone_bricks | 1 | Full cube (greedy mesher) |
| cracked_stone_bricks | 1 | Full cube (greedy mesher) |
| crimson_hyphae | 3 | Full cube (greedy mesher) |
| crimson_planks | 1 | Full cube (greedy mesher) |
| crimson_stem | 3 | Full cube (greedy mesher) |
| crying_obsidian | 1 | Full cube (greedy mesher) |
| cut_red_sandstone | 1 | Full cube (greedy mesher) |
| cut_sandstone | 1 | Full cube (greedy mesher) |
| cyan_concrete | 1 | Full cube (greedy mesher) |
| cyan_terracotta | 1 | Full cube (greedy mesher) |
| cyan_wool | 1 | Full cube (greedy mesher) |
| dark_oak_leaves | 28 | Full cube (greedy mesher) |
| dark_oak_log | 3 | Full cube (greedy mesher) |
| dark_oak_planks | 1 | Full cube (greedy mesher) |
| dark_oak_wood | 3 | Full cube (greedy mesher) |
| dark_prismarine | 1 | Full cube (greedy mesher) |
| dead_brain_coral_block | 1 | Full cube (greedy mesher) |
| dead_bubble_coral_block | 1 | Full cube (greedy mesher) |
| dead_horn_coral_block | 1 | Full cube (greedy mesher) |
| dead_tube_coral_block | 1 | Full cube (greedy mesher) |
| deepslate | 3 | Full cube (greedy mesher) |
| deepslate_bricks | 1 | Full cube (greedy mesher) |
| deepslate_coal_ore | 1 | Full cube (greedy mesher) |
| deepslate_copper_ore | 1 | Full cube (greedy mesher) |
| deepslate_diamond_ore | 1 | Full cube (greedy mesher) |
| deepslate_emerald_ore | 1 | Full cube (greedy mesher) |
| deepslate_gold_ore | 1 | Full cube (greedy mesher) |
| deepslate_iron_ore | 1 | Full cube (greedy mesher) |
| deepslate_lapis_ore | 1 | Full cube (greedy mesher) |
| deepslate_redstone_ore | 2 | Full cube (greedy mesher) |
| deepslate_tiles | 1 | Full cube (greedy mesher) |
| diamond_block | 1 | Full cube (greedy mesher) |
| diamond_ore | 1 | Full cube (greedy mesher) |
| diorite | 1 | Full cube (greedy mesher) |
| dirt | 1 | Full cube (greedy mesher) |
| dripstone_block | 1 | Full cube (greedy mesher) |
| emerald_block | 1 | Full cube (greedy mesher) |
| emerald_ore | 1 | Full cube (greedy mesher) |
| end_stone | 1 | Full cube (greedy mesher) |
| end_stone_bricks | 1 | Full cube (greedy mesher) |
| gilded_blackstone | 1 | Full cube (greedy mesher) |
| glowstone | 1 | Full cube (greedy mesher) |
| gold_block | 1 | Full cube (greedy mesher) |
| gold_ore | 1 | Full cube (greedy mesher) |
| granite | 1 | Full cube (greedy mesher) |
| grass_block | 2 | Full cube (greedy mesher) |
| gravel | 1 | Full cube (greedy mesher) |
| gray_concrete | 1 | Full cube (greedy mesher) |
| gray_terracotta | 1 | Full cube (greedy mesher) |
| gray_wool | 1 | Full cube (greedy mesher) |
| green_concrete | 1 | Full cube (greedy mesher) |
| green_terracotta | 1 | Full cube (greedy mesher) |
| green_wool | 1 | Full cube (greedy mesher) |
| hay_block | 3 | Full cube (greedy mesher) |
| honeycomb_block | 1 | Full cube (greedy mesher) |
| horn_coral_block | 1 | Full cube (greedy mesher) |
| infested_chiseled_stone_bricks | 1 | Full cube (greedy mesher) |
| infested_cobblestone | 1 | Full cube (greedy mesher) |
| infested_cracked_stone_bricks | 1 | Full cube (greedy mesher) |
| infested_deepslate | 3 | Full cube (greedy mesher) |
| infested_mossy_stone_bricks | 1 | Full cube (greedy mesher) |
| infested_stone | 1 | Full cube (greedy mesher) |
| infested_stone_bricks | 1 | Full cube (greedy mesher) |
| iron_block | 1 | Full cube (greedy mesher) |
| iron_ore | 1 | Full cube (greedy mesher) |
| jungle_leaves | 28 | Full cube (greedy mesher) |
| jungle_log | 3 | Full cube (greedy mesher) |
| jungle_planks | 1 | Full cube (greedy mesher) |
| jungle_wood | 3 | Full cube (greedy mesher) |
| lapis_block | 1 | Full cube (greedy mesher) |
| lapis_ore | 1 | Full cube (greedy mesher) |
| light_blue_concrete | 1 | Full cube (greedy mesher) |
| light_blue_terracotta | 1 | Full cube (greedy mesher) |
| light_blue_wool | 1 | Full cube (greedy mesher) |
| light_gray_concrete | 1 | Full cube (greedy mesher) |
| light_gray_terracotta | 1 | Full cube (greedy mesher) |
| light_gray_wool | 1 | Full cube (greedy mesher) |
| lime_concrete | 1 | Full cube (greedy mesher) |
| lime_terracotta | 1 | Full cube (greedy mesher) |
| lime_wool | 1 | Full cube (greedy mesher) |
| magenta_concrete | 1 | Full cube (greedy mesher) |
| magenta_terracotta | 1 | Full cube (greedy mesher) |
| magenta_wool | 1 | Full cube (greedy mesher) |
| magma_block | 1 | Full cube (greedy mesher) |
| mangrove_leaves | 28 | Full cube (greedy mesher) |
| mangrove_log | 3 | Full cube (greedy mesher) |
| mangrove_planks | 1 | Full cube (greedy mesher) |
| mangrove_wood | 3 | Full cube (greedy mesher) |
| moss_block | 1 | Full cube (greedy mesher) |
| mossy_cobblestone | 1 | Full cube (greedy mesher) |
| mossy_stone_bricks | 1 | Full cube (greedy mesher) |
| mud | 1 | Full cube (greedy mesher) |
| mud_bricks | 1 | Full cube (greedy mesher) |
| mushroom_stem | 64 | Full cube (greedy mesher) |
| nether_bricks | 1 | Full cube (greedy mesher) |
| nether_gold_ore | 1 | Full cube (greedy mesher) |
| nether_quartz_ore | 1 | Full cube (greedy mesher) |
| netherite_block | 1 | Full cube (greedy mesher) |
| netherrack | 1 | Full cube (greedy mesher) |
| note_block | 1150 | Full cube (greedy mesher) |
| oak_leaves | 28 | Full cube (greedy mesher) |
| oak_log | 3 | Full cube (greedy mesher) |
| oak_planks | 1 | Full cube (greedy mesher) |
| oak_wood | 3 | Full cube (greedy mesher) |
| obsidian | 1 | Full cube (greedy mesher) |
| orange_concrete | 1 | Full cube (greedy mesher) |
| orange_terracotta | 1 | Full cube (greedy mesher) |
| orange_wool | 1 | Full cube (greedy mesher) |
| packed_mud | 1 | Full cube (greedy mesher) |
| pale_moss_block | 1 | Full cube (greedy mesher) |
| pale_oak_leaves | 28 | Full cube (greedy mesher) |
| pale_oak_log | 3 | Full cube (greedy mesher) |
| pale_oak_planks | 1 | Full cube (greedy mesher) |
| pale_oak_wood | 3 | Full cube (greedy mesher) |
| pink_concrete | 1 | Full cube (greedy mesher) |
| pink_terracotta | 1 | Full cube (greedy mesher) |
| pink_wool | 1 | Full cube (greedy mesher) |
| polished_andesite | 1 | Full cube (greedy mesher) |
| polished_basalt | 3 | Full cube (greedy mesher) |
| polished_blackstone | 1 | Full cube (greedy mesher) |
| polished_blackstone_bricks | 1 | Full cube (greedy mesher) |
| polished_deepslate | 1 | Full cube (greedy mesher) |
| polished_diorite | 1 | Full cube (greedy mesher) |
| polished_granite | 1 | Full cube (greedy mesher) |
| polished_tuff | 1 | Full cube (greedy mesher) |
| prismarine | 1 | Full cube (greedy mesher) |
| prismarine_bricks | 1 | Full cube (greedy mesher) |
| purple_concrete | 1 | Full cube (greedy mesher) |
| purple_terracotta | 1 | Full cube (greedy mesher) |
| purple_wool | 1 | Full cube (greedy mesher) |
| purpur_block | 1 | Full cube (greedy mesher) |
| purpur_pillar | 3 | Full cube (greedy mesher) |
| quartz_block | 1 | Full cube (greedy mesher) |
| quartz_bricks | 1 | Full cube (greedy mesher) |
| raw_copper_block | 1 | Full cube (greedy mesher) |
| raw_gold_block | 1 | Full cube (greedy mesher) |
| raw_iron_block | 1 | Full cube (greedy mesher) |
| red_concrete | 1 | Full cube (greedy mesher) |
| red_nether_bricks | 1 | Full cube (greedy mesher) |
| red_sand | 1 | Full cube (greedy mesher) |
| red_sandstone | 1 | Full cube (greedy mesher) |
| red_terracotta | 1 | Full cube (greedy mesher) |
| red_wool | 1 | Full cube (greedy mesher) |
| redstone_block | 1 | Full cube (greedy mesher) |
| redstone_lamp | 2 | Full cube (greedy mesher) |
| redstone_ore | 2 | Full cube (greedy mesher) |
| reinforced_deepslate | 1 | Full cube (greedy mesher) |
| resin_block | 1 | Full cube (greedy mesher) |
| resin_bricks | 1 | Full cube (greedy mesher) |
| rooted_dirt | 1 | Full cube (greedy mesher) |
| sand | 1 | Full cube (greedy mesher) |
| sandstone | 1 | Full cube (greedy mesher) |
| sculk | 1 | Full cube (greedy mesher) |
| shroomlight | 1 | Full cube (greedy mesher) |
| smooth_basalt | 1 | Full cube (greedy mesher) |
| smooth_red_sandstone | 1 | Full cube (greedy mesher) |
| smooth_sandstone | 1 | Full cube (greedy mesher) |
| smooth_stone | 1 | Full cube (greedy mesher) |
| soul_sand | 1 | Full cube (greedy mesher) |
| soul_soil | 1 | Full cube (greedy mesher) |
| spruce_leaves | 28 | Full cube (greedy mesher) |
| spruce_log | 3 | Full cube (greedy mesher) |
| spruce_planks | 1 | Full cube (greedy mesher) |
| spruce_wood | 3 | Full cube (greedy mesher) |
| stone | 1 | Full cube (greedy mesher) |
| stone_bricks | 1 | Full cube (greedy mesher) |
| stripped_acacia_log | 3 | Full cube (greedy mesher) |
| stripped_acacia_wood | 3 | Full cube (greedy mesher) |
| stripped_birch_log | 3 | Full cube (greedy mesher) |
| stripped_birch_wood | 3 | Full cube (greedy mesher) |
| stripped_cherry_log | 3 | Full cube (greedy mesher) |
| stripped_cherry_wood | 3 | Full cube (greedy mesher) |
| stripped_crimson_hyphae | 3 | Full cube (greedy mesher) |
| stripped_crimson_stem | 3 | Full cube (greedy mesher) |
| stripped_dark_oak_log | 3 | Full cube (greedy mesher) |
| stripped_dark_oak_wood | 3 | Full cube (greedy mesher) |
| stripped_jungle_log | 3 | Full cube (greedy mesher) |
| stripped_jungle_wood | 3 | Full cube (greedy mesher) |
| stripped_mangrove_log | 3 | Full cube (greedy mesher) |
| stripped_mangrove_wood | 3 | Full cube (greedy mesher) |
| stripped_oak_log | 3 | Full cube (greedy mesher) |
| stripped_oak_wood | 3 | Full cube (greedy mesher) |
| stripped_pale_oak_log | 3 | Full cube (greedy mesher) |
| stripped_pale_oak_wood | 3 | Full cube (greedy mesher) |
| stripped_spruce_log | 3 | Full cube (greedy mesher) |
| stripped_spruce_wood | 3 | Full cube (greedy mesher) |
| stripped_warped_hyphae | 3 | Full cube (greedy mesher) |
| stripped_warped_stem | 3 | Full cube (greedy mesher) |
| terracotta | 1 | Full cube (greedy mesher) |
| test_instance_block | 1 | Full cube (greedy mesher) |
| tube_coral_block | 1 | Full cube (greedy mesher) |
| tuff | 1 | Full cube (greedy mesher) |
| tuff_bricks | 1 | Full cube (greedy mesher) |
| warped_hyphae | 3 | Full cube (greedy mesher) |
| warped_planks | 1 | Full cube (greedy mesher) |
| warped_stem | 3 | Full cube (greedy mesher) |
| warped_wart_block | 1 | Full cube (greedy mesher) |
| waxed_copper_block | 1 | Full cube (greedy mesher) |
| white_concrete | 1 | Full cube (greedy mesher) |
| white_terracotta | 1 | Full cube (greedy mesher) |
| white_wool | 1 | Full cube (greedy mesher) |
| yellow_concrete | 1 | Full cube (greedy mesher) |
| yellow_terracotta | 1 | Full cube (greedy mesher) |
| yellow_wool | 1 | Full cube (greedy mesher) |

## Unsupported / Needs Review (61 blocks)

These blocks are not clearly categorized and may need to be added to V3 or legacy mesher.

| Block | States | Reason | Sample Properties |
|-------|--------|--------|-------------------|
| black_concrete_powder | 1 | Not categorized - needs review | - |
| blue_concrete_powder | 1 | Not categorized - needs review | - |
| blue_ice | 1 | Not categorized - needs review | - |
| bricks | 1 | Not categorized - needs review | - |
| brown_concrete_powder | 1 | Not categorized - needs review | - |
| budding_amethyst | 1 | Not categorized - needs review | - |
| cartography_table | 1 | Not categorized - needs review | - |
| chiseled_copper | 1 | Not categorized - needs review | - |
| crafting_table | 1 | Not categorized - needs review | - |
| crimson_nylium | 1 | Not categorized - needs review | - |
| cut_copper | 1 | Not categorized - needs review | - |
| cyan_concrete_powder | 1 | Not categorized - needs review | - |
| exposed_chiseled_copper | 1 | Not categorized - needs review | - |
| exposed_copper | 1 | Not categorized - needs review | - |
| exposed_cut_copper | 1 | Not categorized - needs review | - |
| fletching_table | 1 | Not categorized - needs review | - |
| gray_concrete_powder | 1 | Not categorized - needs review | - |
| green_concrete_powder | 1 | Not categorized - needs review | - |
| ice | 1 | Not categorized - needs review | - |
| jukebox | 2 | Not categorized - needs review | has_record=false |
| light_blue_concrete_powder | 1 | Not categorized - needs review | - |
| light_gray_concrete_powder | 1 | Not categorized - needs review | - |
| lime_concrete_powder | 1 | Not categorized - needs review | - |
| magenta_concrete_powder | 1 | Not categorized - needs review | - |
| melon | 1 | Not categorized - needs review | - |
| ochre_froglight | 3 | Not categorized - needs review | axis=x |
| orange_concrete_powder | 1 | Not categorized - needs review | - |
| oxidized_chiseled_copper | 1 | Not categorized - needs review | - |
| oxidized_copper | 1 | Not categorized - needs review | - |
| oxidized_cut_copper | 1 | Not categorized - needs review | - |
| packed_ice | 1 | Not categorized - needs review | - |
| pearlescent_froglight | 3 | Not categorized - needs review | axis=x |
| pink_concrete_powder | 1 | Not categorized - needs review | - |
| pumpkin | 1 | Not categorized - needs review | - |
| purple_concrete_powder | 1 | Not categorized - needs review | - |
| quartz_pillar | 3 | Not categorized - needs review | axis=x |
| red_concrete_powder | 1 | Not categorized - needs review | - |
| resin_clump | 128 | Not categorized - needs review | east=false, waterlogged=false, south=fal |
| smithing_table | 1 | Not categorized - needs review | - |
| smooth_quartz | 1 | Not categorized - needs review | - |
| sponge | 1 | Not categorized - needs review | - |
| tnt | 2 | Not categorized - needs review | unstable=false |
| verdant_froglight | 3 | Not categorized - needs review | axis=x |
| warped_nylium | 1 | Not categorized - needs review | - |
| waxed_chiseled_copper | 1 | Not categorized - needs review | - |
| waxed_cut_copper | 1 | Not categorized - needs review | - |
| waxed_exposed_chiseled_copper | 1 | Not categorized - needs review | - |
| waxed_exposed_copper | 1 | Not categorized - needs review | - |
| waxed_exposed_cut_copper | 1 | Not categorized - needs review | - |
| waxed_oxidized_chiseled_copper | 1 | Not categorized - needs review | - |
| waxed_oxidized_copper | 1 | Not categorized - needs review | - |
| waxed_oxidized_cut_copper | 1 | Not categorized - needs review | - |
| waxed_weathered_chiseled_copper | 1 | Not categorized - needs review | - |
| waxed_weathered_copper | 1 | Not categorized - needs review | - |
| waxed_weathered_cut_copper | 1 | Not categorized - needs review | - |
| weathered_chiseled_copper | 1 | Not categorized - needs review | - |
| weathered_copper | 1 | Not categorized - needs review | - |
| weathered_cut_copper | 1 | Not categorized - needs review | - |
| wet_sponge | 1 | Not categorized - needs review | - |
| white_concrete_powder | 1 | Not categorized - needs review | - |
| yellow_concrete_powder | 1 | Not categorized - needs review | - |

## Block Entities (4806 total)

| Entity Type | Count | Rendering Support |
|-------------|-------|-------------------|
| hanging_sign | 864 | ✅ Partial |
| shelf | 768 | ❌ Not rendered |
| sign | 480 | ✅ Partial |
| calibrated_sculk_sensor | 384 | ❌ Not rendered |
| banner | 320 | ✅ Partial |
| skull | 280 | ✅ Partial |
| bed | 256 | ✅ Partial |
| chiseled_bookshelf | 256 | ❌ Not rendered |
| copper_golem_statue | 256 | ❌ Not rendered |
| chest | 216 | ✅ Partial |
| shulker_box | 102 | ✅ Partial |
| sculk_sensor | 96 | ❌ Not rendered |
| campfire | 64 | ❌ Not rendered |
| crafter | 48 | ❌ Not rendered |
| beehive | 48 | ❌ Not rendered |
| command_block | 36 | ❌ Not rendered |
| daylight_detector | 32 | ❌ Not rendered |
| bell | 32 | ❌ Not rendered |
| vault | 32 | ❌ Not rendered |
| trapped_chest | 24 | ✅ Partial |
| creaking_heart | 18 | ❌ Not rendered |
| comparator | 16 | ❌ Not rendered |
| lectern | 16 | ❌ Not rendered |
| decorated_pot | 16 | ❌ Not rendered |
| dispenser | 12 | ❌ Not rendered |
| trial_spawner | 12 | ❌ Not rendered |
| jigsaw | 12 | ❌ Not rendered |
| barrel | 12 | ✅ Partial |
| dropper | 12 | ❌ Not rendered |
| hopper | 10 | ❌ Not rendered |
| sculk_shrieker | 8 | ❌ Not rendered |
| ender_chest | 8 | ✅ Partial |
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
| end_gateway | 1 | ❌ Not rendered |
| beacon | 1 | ✅ Partial |
| test_instance_block | 1 | ❌ Not rendered |
| end_portal | 1 | ❌ Not rendered |

## Entity Rendering Support

Currently, the viewer does not render entities like mobs, item frames, armor stands, etc.
Only block entities (chests, signs, beds, etc.) have partial support.
