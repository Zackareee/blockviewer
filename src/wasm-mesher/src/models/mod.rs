//! Models module - Block state registry and model meshing
//!
//! This module handles:
//! - State string → state ID mapping
//! - Model geometry storage
//! - Model meshing with face culling
//! - Block-name-based geometry lookup (V3)

pub mod registry;
pub mod geometry;
pub mod mesher;
pub mod position_hash;
pub mod block_registry;

// Re-export registry types and functions
pub use registry::{
    init_state_registry, get_state_id, 
    init_model_registry, get_model_geometry, is_model_registry_initialized,
    init_model_registry_v2, get_model_entry_v2, is_hash_model_registry_initialized,
    ModelEntryV2, ModelRegistryV2, flags,
};
pub use geometry::{ModelGeometry, ModelFace, ModelMeshData};
pub use mesher::{mesh_models, mesh_models_v2, mesh_models_bounded, ModelMeshResult};

// V3: Block-name-based registry
pub use block_registry::{
    init_block_model_registry, is_block_model_registry_initialized,
    get_block_model_index, get_block_variant_count, get_block_model_flags,
    get_block_model_registry,
    BlockModelRegistry, BlockModelData, BlockVariant, BakedFace, FaceDirection,
    block_flags,
};

// V3: Block-name-based meshing
pub mod mesher_v3;
pub use mesher_v3::mesh_models_v3;
