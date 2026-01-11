//! Models module - Block state registry and model meshing
//!
//! This module handles:
//! - State string → state ID mapping
//! - Model geometry storage
//! - Model meshing with face culling

pub mod registry;
pub mod geometry;
pub mod mesher;
pub mod position_hash;

// Re-export registry types and functions
pub use registry::{
    init_state_registry, get_state_id, 
    init_model_registry, get_model_geometry, is_model_registry_initialized,
    init_model_registry_v2, get_model_entry_v2, is_hash_model_registry_initialized,
    ModelEntryV2, ModelRegistryV2, flags,
};
pub use geometry::{ModelGeometry, ModelFace, ModelMeshData};
pub use mesher::{mesh_models, mesh_models_v2, mesh_models_bounded, ModelMeshResult};

