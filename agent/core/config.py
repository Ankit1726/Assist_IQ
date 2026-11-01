from functools import lru_cache
from pathlib import Path
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parents[2]

class Settings(BaseSettings):
    app_name: str = "AssistIQ — Team Knowledge Assistant"
    app_env: str = "development"
    groq_api_key: str = ""
    tavily_api_key: str = ""
    pinecone_api_key: str = ""
    pinecone_index_name: str = "fde-it-support-rag"
    pinecone_namespace: str = "company-it-kb"
    embedding_model: str = "all-MiniLM-L6-v2"
    groq_model: str = "openai/gpt-oss-120b"
    llm_timeout_seconds: float = 10
    tavily_timeout_seconds: float = 8
    top_k: int = 4
    max_retries: int = 0
    max_upload_size_bytes: int = Field(default=10 * 1024 * 1024, gt=0)
    admin_api_key: str = ""
    audit_db_path: str = str(BASE_DIR / "data" / "audit.db")
    upload_dir: str = str(BASE_DIR / "uploads")
    sample_kb_dir: str = str(BASE_DIR / "data" / "sample_kb")

    model_config = SettingsConfigDict(env_file=str(BASE_DIR / ".env"), extra="ignore")

@lru_cache
def get_settings() -> Settings:
    return Settings()