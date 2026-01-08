//! Models module - Block state registry and model meshing
//!
//! This module handles:
//! - State string → state ID mapping
//! - Model geometry storage
//! - Model meshing with face culling

pub mod registry;
pub mod geometry;
pub mod mesher;

pub use registry::{init_state_registry, get_state_id, init_model_registry, get_model_geometry};
pub use geometry::{ModelGeometry, ModelFace};
pub use mesher::{mesh_models, ModelMeshResult};

