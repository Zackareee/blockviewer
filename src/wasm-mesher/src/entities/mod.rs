//! Entity Model System for Block Entities
//!
//! This module handles rendering of block entities (chests, beds, signs, skulls,
//! banners, bells, shulker boxes) through the WASM pipeline.
//!
//! ## Architecture
//!
//! - `entity_registry.rs` - Legacy entity geometry registry (for item frames, etc.)
//! - `block_entity_registry.rs` - New block entity model registry (chests, beds, etc.)
//! - `entity_state_grid.rs` - Sparse grid storing entity state per position  
//! - `entity_mesher.rs` - Generates mesh geometry from entity states
//! - `block_entity_mesher.rs` - Generates mesh geometry from block entity models

pub mod entity_registry;
pub mod block_entity_registry;
pub mod entity_state_grid;
pub mod entity_mesher;
pub mod block_entity_mesher;

pub use entity_registry::EntityModelRegistry;
pub use block_entity_registry::BlockEntityRegistry;
pub use entity_state_grid::EntityStateGrid;
pub use entity_mesher::mesh_entities;
pub use block_entity_mesher::mesh_block_entities;
