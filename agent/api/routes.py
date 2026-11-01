from pathlib import Path
import logging
import hmac
from uuid import uuid4
from zipfile import BadZipFile
from docx.opc.exceptions import PackageNotFoundError
import requests
from pydantic import BaseModel, Field, field_validator
from fastapi import APIRouter, UploadFile, File, HTTPException, Header
from pinecone.exceptions import PineconeException
from pypdf.errors import PdfReadError

from agent.core.config import get_settings
from agent.rag.workflow import ask
from agent.rag.vectorstore import add_documents
from agent.services.audit import write_audit
from agent.services.ingestion import load_file, chunk_documents, SUPPORTED

router = APIRouter(prefix="/api")
settings = get_settings()
logger = logging.getLogger(__name__)


class ChatRequest(BaseModel):
    question: str = Field(min_length=2, max_length=5000)

    @field_validator("question")
    @classmethod
    def normalize_question(cls, value: str) -> str:
        value = value.strip()
        if len(value) < 2:
            raise ValueError("Enter at least 2 characters for your question.")
        return value


@router.get("/health")
def health():
    return {"status": "Ok", "service": settings.app_name}


@router.get("/status")
def status():
    checks = {
        "groq": {
            "label": "AI responses (Groq)",
            "configured": bool(settings.groq_api_key.strip()),
        },
        "pinecone": {
            "label": "Private knowledge base (Pinecone)",
            "configured": bool(settings.pinecone_api_key.strip()),
        },
        "tavily": {
            "label": "External web fallback (Tavily)",
            "configured": bool(settings.tavily_api_key.strip()),
        },
        "admin": {
            "label": "Secure document uploads",
            "configured": bool(settings.admin_api_key.strip())
            and settings.admin_api_key.strip().casefold() != "change-me",
        },
    }
    return {
        "readiness": "ready"
        if all(check["configured"] for check in checks.values())
        else "configuration_required",
        "checks": checks,
        "max_upload_size_bytes": settings.max_upload_size_bytes,
    }


@router.post("/chat")
def chat(payload: ChatRequest):
    try:
        result = ask(payload.question)
        write_audit(payload.question, result["source_used"], result.get("trace", []))

        return {
            "answer": result["answer"],
            "source_used": result["source_used"],
            "trace": result.get("trace", []),
            "citations": result.get("citations", []),
            "rewritten_query": result.get("current_query", payload.question),
        }
    except Exception as exc:
        logger.exception("Chat request failed")
        raise HTTPException(
            status_code=502,
            detail="The assistant is temporarily unavailable. Please try again shortly.",
        ) from exc


@router.post("/ingest")
async def ingest(file: UploadFile = File(...), x_admin_key: str = Header(default="")):
    configured_admin_key = settings.admin_api_key.strip()
    if not configured_admin_key or configured_admin_key.casefold() == "change-me":
        raise HTTPException(
            status_code=503,
            detail="Document uploads are unavailable until ADMIN_API_KEY is configured.",
        )
    if not hmac.compare_digest(x_admin_key, configured_admin_key):
        raise HTTPException(status_code=401, detail="Invalid admin key")
    filename = Path((file.filename or "").replace("\\", "/")).name.strip()
    if not filename:
        raise HTTPException(status_code=400, detail="A filename is required")
    suffix = Path(filename).suffix.lower()
    if suffix not in SUPPORTED:
        raise HTTPException(
            status_code=400, detail=f"Supported: {', '.join(sorted(SUPPORTED))}"
        )
    upload_dir = Path(settings.upload_dir)
    upload_dir.mkdir(parents=True, exist_ok=True)
    contents = await file.read(settings.max_upload_size_bytes + 1)
    if len(contents) > settings.max_upload_size_bytes:
        max_size_mb = settings.max_upload_size_bytes / (1024 * 1024)
        limit = (
            f"{max_size_mb:g} MB"
            if max_size_mb >= 1
            else f"{settings.max_upload_size_bytes} bytes"
        )
        raise HTTPException(
            status_code=413,
            detail=f"The selected document exceeds the upload limit of {limit}.",
        )
    if not contents:
        raise HTTPException(status_code=400, detail="The selected document is empty")
    dest = upload_dir / filename
    indexed = False
    created = False
    try:
        try:
            with dest.open("xb") as uploaded_file:
                created = True
                uploaded_file.write(contents)
        except FileExistsError:
            path = Path(filename)
            while True:
                dest = upload_dir / f"{path.stem}-{uuid4().hex}{path.suffix}"
                try:
                    with dest.open("xb") as uploaded_file:
                        created = True
                        uploaded_file.write(contents)
                    break
                except FileExistsError:
                    continue
        try:
            docs = load_file(dest)
        except (
            BadZipFile,
            OSError,
            PackageNotFoundError,
            PdfReadError,
            UnicodeError,
            ValueError,
        ) as exc:
            raise HTTPException(
                status_code=400,
                detail="The selected document could not be read. Check that it is valid and try again.",
            ) from exc
        chunks = chunk_documents(docs)
        if not chunks:
            raise HTTPException(
                status_code=400,
                detail="The selected document contains no readable text.",
            )
        try:
            ids = add_documents(chunks)
        except (
            OSError,
            PineconeException,
            requests.RequestException,
            RuntimeError,
            ValueError,
        ) as exc:
            logger.exception("Document indexing failed")
            raise HTTPException(
                status_code=502,
                detail="The document could not be indexed. Please try again shortly.",
            ) from exc
        ids_created = len(ids)
        indexed = True
        return {
            "message": "Document indexed",
            "file": dest.name,
            "chunks": len(chunks),
            "ids_created": ids_created,
        }
    finally:
        if created and not indexed:
            dest.unlink(missing_ok=True)