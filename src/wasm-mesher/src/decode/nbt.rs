//! NBT structures for Minecraft chunk data
//!
//! These serde-compatible structures match the Minecraft NBT chunk format.
//! Supports multiple Minecraft versions:
//! - Modern (1.18+): sections with block_states { palette, data }
//! - Legacy (1.13-1.17): Palette and BlockStates at section level
//! - Pre-1.13: Blocks byte array

use serde::Deserialize;
use fastnbt::{ByteArray, LongArray, IntArray};

/// Root chunk data structure
/// 
/// Modern chunks have sections at the root level.
/// Legacy chunks have a Level compound containing sections.
#[derive(Debug, Clone, Deserialize)]
pub struct ChunkData {
    /// Modern format (1.18+): sections at root
    #[serde(default)]
    pub sections: Option<Vec<Section>>,
    
    /// Legacy format: Level compound
    #[serde(rename = "Level")]
    pub level: Option<LevelData>,
    
    /// Block entities (modern format)
    #[serde(default)]
    pub block_entities: Option<Vec<BlockEntity>>,
}

/// Legacy Level compound structure
#[derive(Debug, Clone, Deserialize)]
pub struct LevelData {
    /// Sections array
    #[serde(rename = "Sections")]
    pub sections: Option<Vec<Section>>,
    
    /// Block entities (legacy format)
    #[serde(rename = "TileEntities")]
    pub tile_entities: Option<Vec<BlockEntity>>,
    
    /// Chunk X position
    #[serde(rename = "xPos")]
    pub x_pos: Option<i32>,
    
    /// Chunk Z position
    #[serde(rename = "zPos")]
    pub z_pos: Option<i32>,
}

/// Section structure (16x16x16 blocks)
#[derive(Debug, Clone, Deserialize)]
pub struct Section {
    /// Section Y index (world Y = index * 16 for modern, absolute for legacy)
    #[serde(rename = "Y", alias = "y")]
    pub y: i8,
    
    /// Modern format (1.18+): block states with palette and packed data
    #[serde(default)]
    pub block_states: Option<BlockStates>,
    
    /// Legacy format (1.13-1.17): Palette array
    #[serde(rename = "Palette")]
    pub palette: Option<Vec<PaletteEntry>>,
    
    /// Legacy format: packed block states (i64 array)
    #[serde(rename = "BlockStates")]
    pub block_states_legacy: Option<LongArray>,
    
    /// Pre-1.13 format: raw block IDs
    #[serde(rename = "Blocks")]
    pub blocks: Option<ByteArray>,
    
    /// Pre-1.13 format: additional block ID bits
    #[serde(rename = "Add")]
    pub add: Option<ByteArray>,
    
    /// Sky light data (nibble-packed, 2048 bytes)
    #[serde(rename = "SkyLight", alias = "sky_light")]
    pub sky_light: Option<ByteArray>,
    
    /// Block light data (nibble-packed, 2048 bytes)
    #[serde(rename = "BlockLight", alias = "block_light")]
    pub block_light: Option<ByteArray>,
    
    /// Biomes (modern format)
    #[serde(default)]
    pub biomes: Option<Biomes>,
}

/// Block states container (modern format)
#[derive(Debug, Clone, Deserialize)]
pub struct BlockStates {
    /// Palette of block types in this section
    #[serde(default)]
    pub palette: Option<Vec<PaletteEntry>>,
    
    /// Packed block indices (i64 array)
    /// Each entry uses ceil(log2(palette.len())) bits
    #[serde(default)]
    pub data: Option<LongArray>,
}

/// Palette entry representing a block type
#[derive(Debug, Clone, Deserialize)]
pub struct PaletteEntry {
    /// Block name (e.g., "minecraft:stone")
    #[serde(rename = "Name", alias = "name")]
    pub name: String,
    
    /// Block properties (state)
    #[serde(rename = "Properties", alias = "properties")]
    pub properties: Option<BlockProperties>,
}

/// Block properties (state values)
/// 
/// Using Option<String> for all fields to handle various Minecraft versions
/// and block types flexibly.
#[derive(Debug, Clone, Deserialize)]
pub struct BlockProperties {
    /// Axis for rotatable blocks (logs, pillars): x, y, z
    pub axis: Option<String>,
    
    /// Facing direction for directional blocks: north, east, south, west, up, down
    pub facing: Option<String>,
    
    /// Half for slabs: top, bottom
    pub half: Option<String>,
    
    /// Type for double slabs: top, bottom, double
    #[serde(rename = "type")]
    pub slab_type: Option<String>,
    
    /// Fluid level: 0-15
    pub level: Option<String>,
    
    /// Waterlogged state
    pub waterlogged: Option<String>,
    
    /// Lit state (furnaces, campfires, etc.)
    pub lit: Option<String>,
    
    /// Age (crops, saplings)
    pub age: Option<String>,
    
    /// Part for beds, doors
    pub part: Option<String>,
    
    /// Open state for doors, trapdoors
    pub open: Option<String>,
    
    /// Powered state for buttons, pressure plates
    pub powered: Option<String>,
    
    /// Snowy state for grass blocks
    pub snowy: Option<String>,
    
    /// Shape for stairs, rails
    pub shape: Option<String>,
    
    /// Moisture for farmland
    pub moisture: Option<String>,
    
    /// Hinge for doors
    pub hinge: Option<String>,
    
    /// Extended for pistons
    pub extended: Option<String>,
    
    /// Attached for tripwire hooks
    pub attached: Option<String>,
    
    /// Disarmed for tripwire
    pub disarmed: Option<String>,
    
    /// In wall for fence gates
    pub in_wall: Option<String>,
    
    /// Short for pistons
    pub short: Option<String>,
    
    /// Enabled for hoppers
    pub enabled: Option<String>,
    
    /// Triggered for dispensers, droppers
    pub triggered: Option<String>,
    
    /// Conditional for command blocks
    pub conditional: Option<String>,
    
    /// Unstable for TNT
    pub unstable: Option<String>,
    
    /// Berries for cave vines
    pub berries: Option<String>,
    
    /// Candles count
    pub candles: Option<String>,
    
    /// Layers for snow
    pub layers: Option<String>,
    
    /// Rotation for signs, banners, heads
    pub rotation: Option<String>,
    
    /// Bites for cake
    pub bites: Option<String>,
    
    /// Charges for respawn anchors
    pub charges: Option<String>,
    
    /// Eggs for turtle eggs
    pub eggs: Option<String>,
    
    /// Hatch for turtle eggs
    pub hatch: Option<String>,
    
    /// Pickles for sea pickles
    pub pickles: Option<String>,
    
    /// Honey level for beehives
    pub honey_level: Option<String>,
    
    /// Mode for comparators, structure blocks
    pub mode: Option<String>,
    
    /// Delay for repeaters
    pub delay: Option<String>,
    
    /// Locked for repeaters
    pub locked: Option<String>,
    
    /// Power for redstone components
    pub power: Option<String>,
    
    /// Note for note blocks
    pub note: Option<String>,
    
    /// Instrument for note blocks
    pub instrument: Option<String>,
    
    /// Has bottle for brewing stands (0, 1, 2)
    pub has_bottle_0: Option<String>,
    pub has_bottle_1: Option<String>,
    pub has_bottle_2: Option<String>,
    
    /// Eye for end portal frames
    pub eye: Option<String>,
    
    /// Bloom for sculk catalyst
    pub bloom: Option<String>,
    
    /// Shrieking for sculk shrieker
    pub shrieking: Option<String>,
    
    /// Can summon for sculk shrieker
    pub can_summon: Option<String>,
    
    /// Sculk sensor phase
    pub sculk_sensor_phase: Option<String>,
    
    /// Distance for leaves, scaffolding
    pub distance: Option<String>,
    
    /// Persistent for leaves
    pub persistent: Option<String>,
    
    /// Thickness for pointed dripstone
    pub thickness: Option<String>,
    
    /// Vertical direction for pointed dripstone
    pub vertical_direction: Option<String>,
    
    /// Tilt for big dripleaf
    pub tilt: Option<String>,
    
    /// Hanging for lanterns
    pub hanging: Option<String>,
    
    /// Signal fire for campfires
    pub signal_fire: Option<String>,
    
    /// Attachment for bells
    pub attachment: Option<String>,
    
    /// Drag for bubble columns
    pub drag: Option<String>,
    
    /// Bottom for scaffolding
    pub bottom: Option<String>,
    
    /// Orientation for jigsaw blocks
    pub orientation: Option<String>,
    
    /// Has book for lectern
    pub has_book: Option<String>,
    
    /// Slot occupied for chiseled bookshelf
    pub slot_0_occupied: Option<String>,
    pub slot_1_occupied: Option<String>,
    pub slot_2_occupied: Option<String>,
    pub slot_3_occupied: Option<String>,
    pub slot_4_occupied: Option<String>,
    pub slot_5_occupied: Option<String>,
    
    /// Last interaction for chiseled bookshelf
    pub last_interaction_book_slot: Option<String>,
    
    /// Dusted for suspicious sand/gravel
    pub dusted: Option<String>,
    
    /// Cracked for decorated pots
    pub cracked: Option<String>,
    
    /// Crafting for crafter
    pub crafting: Option<String>,
    
    /// Ominous for trial spawner
    pub ominous: Option<String>,
    
    /// Trial spawner state
    pub trial_spawner_state: Option<String>,
    
    /// Vault state
    pub vault_state: Option<String>,
    
    /// Tip for copper bulb
    pub tip: Option<String>,
    
    /// Flower amount for pink petals
    pub flower_amount: Option<String>,
    
    /// Segment amount for leaf litter
    pub segment_amount: Option<String>,
    
    /// Connection states for fences/walls
    pub north: Option<String>,
    pub east: Option<String>,
    pub south: Option<String>,
    pub west: Option<String>,
    pub up: Option<String>,
    pub down: Option<String>,
}

/// Biomes container (modern format)
#[derive(Debug, Clone, Deserialize)]
pub struct Biomes {
    /// Palette of biome types
    #[serde(default)]
    pub palette: Option<Vec<String>>,
    
    /// Packed biome indices
    #[serde(default)]
    pub data: Option<LongArray>,
}

/// Block entity (tile entity) structure
#[derive(Debug, Clone, Deserialize)]
pub struct BlockEntity {
    /// Entity type ID
    #[serde(rename = "id", alias = "Id")]
    pub id: Option<String>,
    
    /// X position
    #[serde(rename = "x", alias = "X")]
    pub x: Option<i32>,
    
    /// Y position
    #[serde(rename = "y", alias = "Y")]
    pub y: Option<i32>,
    
    /// Z position
    #[serde(rename = "z", alias = "Z")]
    pub z: Option<i32>,
    
    /// Beacon levels (for beacon blocks)
    #[serde(rename = "Levels", alias = "levels")]
    pub levels: Option<i32>,
    
    /// Keep packed to avoid deserializing everything
    #[serde(flatten)]
    pub other: std::collections::HashMap<String, fastnbt::Value>,
}


