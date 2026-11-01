import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from langchain_core.documents import Document

from agent.api import routes
from agent.rag import workflow


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.settings = {
            name: getattr(routes.settings, name)
            for name in (
                "app_name",
                "groq_api_key",
                "pinecone_api_key",
                "tavily_api_key",
                "admin_api_key",
                "upload_dir",
                "max_upload_size_bytes",
            )
        }
        routes.settings.app_name = "Test AssistIQ"
        routes.settings.groq_api_key = "test-groq-key"
        routes.settings.pinecone_api_key = "test-pinecone-key"
        routes.settings.tavily_api_key = "test-tavily-key"
        routes.settings.admin_api_key = "test-admin-key"
        routes.settings.max_upload_size_bytes = 10 * 1024 * 1024
        self.temp_dir = tempfile.TemporaryDirectory()
        routes.settings.upload_dir = self.temp_dir.name

        app = FastAPI()
        app.include_router(routes.router)
        self.client = TestClient(app)

    def tearDown(self):
        for name, value in self.settings.items():
            setattr(routes.settings, name, value)
        self.temp_dir.cleanup()

    def upload(self, filename, content=b"VPN guide"):
        return self.client.post(
            "/api/ingest",
            headers={"X-Admin-Key": "test-admin-key"},
            files={"file": (filename, content, "text/plain")},
        )

    def test_health_and_status_do_not_expose_secrets(self):
        self.assertEqual(self.client.get("/api/health").status_code, 200)
        response = self.client.get("/api/status")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["readiness"], "ready")
        self.assertNotIn("test-admin-key", response.text)

    def test_chat_validates_question_and_trims_whitespace(self):
        with patch.object(routes, "ask") as ask:
            for question in ("", " ", " x ", "q" * 5001):
                self.assertEqual(
                    self.client.post("/api/chat", json={"question": question}).status_code,
                    422,
                )
            ask.assert_not_called()

    def test_chat_returns_answer_and_writes_audit(self):
        result = {
            "answer": "Restart the client.",
            "source_used": "private_kb",
            "trace": ["retrieved"],
            "citations": [],
            "current_query": "VPN reset",
        }
        with (
            patch.object(routes, "ask", return_value=result) as ask,
            patch.object(routes, "write_audit") as audit,
        ):
            response = self.client.post("/api/chat", json={"question": " VPN reset "})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["answer"], result["answer"])
        ask.assert_called_once_with("VPN reset")
        audit.assert_called_once_with("VPN reset", "private_kb", ["retrieved"])

    def test_chat_provider_failure_is_reported(self):
        with (
            self.assertLogs("agent.api.routes", level="ERROR"),
            patch.object(routes, "ask", side_effect=RuntimeError("provider internals")),
        ):
            response = self.client.post("/api/chat", json={"question": "VPN reset"})
        self.assertEqual(response.status_code, 502)
        self.assertNotIn("provider internals", response.text)

    def test_upload_rejects_bad_auth_unsafe_configuration_and_bad_types(self):
        routes.settings.admin_api_key = "change-me"
        response = self.client.post(
            "/api/ingest",
            headers={"X-Admin-Key": "change-me"},
            files={"file": ("guide.txt", b"VPN")},
        )
        self.assertEqual(response.status_code, 503)

        routes.settings.admin_api_key = "test-admin-key"
        response = self.client.post(
            "/api/ingest",
            headers={"X-Admin-Key": "wrong"},
            files={"file": ("guide.txt", b"VPN")},
        )
        self.assertEqual(response.status_code, 401)
        self.assertEqual(self.upload("guide.exe").status_code, 400)
        self.assertEqual(self.upload("empty.txt", b"").status_code, 400)

    def test_upload_enforces_limit_and_cleans_unreadable_files(self):
        routes.settings.max_upload_size_bytes = 4
        response = self.upload("large.txt", b"12345")
        self.assertEqual(response.status_code, 413)

        routes.settings.max_upload_size_bytes = 10 * 1024 * 1024
        with patch.object(routes, "load_file", side_effect=ValueError("invalid document")):
            response = self.upload("invalid.txt")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(list(Path(self.temp_dir.name).iterdir()), [])

    def test_upload_rejects_empty_documents_and_index_failures(self):
        with (
            patch.object(routes, "load_file", return_value=[]),
            patch.object(routes, "chunk_documents", return_value=[]),
            patch.object(routes, "add_documents") as add_documents,
        ):
            response = self.upload("blank.txt", b"  ")
        self.assertEqual(response.status_code, 400)
        add_documents.assert_not_called()

        with (
            self.assertLogs("agent.api.routes", level="ERROR"),
            patch.object(routes, "load_file", return_value=[Document(page_content="VPN")]),
            patch.object(
                routes,
                "chunk_documents",
                return_value=[Document(page_content="VPN")],
            ),
            patch.object(
                routes, "add_documents", side_effect=RuntimeError("provider internals")
            ),
        ):
            response = self.upload("failed.txt")
        self.assertEqual(response.status_code, 502)
        self.assertFalse((Path(self.temp_dir.name) / "failed.txt").exists())

    def test_upload_success_sanitizes_path_and_preserves_existing_file(self):
        existing = Path(self.temp_dir.name) / "guide.txt"
        existing.write_text("existing document", encoding="utf-8")
        with (
            patch.object(routes, "load_file", return_value=[Document(page_content="VPN")]),
            patch.object(
                routes,
                "chunk_documents",
                return_value=[Document(page_content="VPN")],
            ),
            patch.object(routes, "add_documents", return_value=["vector-id"]),
        ):
            response = self.upload(r"..\folder\guide.txt")
        self.assertEqual(response.status_code, 200)
        self.assertRegex(response.json()["file"], r"^guide-[0-9a-f]{32}\.txt$")
        self.assertEqual(existing.read_text(encoding="utf-8"), "existing document")
        self.assertEqual(len(list(Path(self.temp_dir.name).iterdir())), 2)


class ApplicationSmokeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with patch("agent.services.audit.init_db"):
            from agent.main import app
        cls.client = TestClient(app)

    def test_home_and_static_assets_are_served(self):
        self.assertEqual(self.client.get("/").status_code, 200)
        self.assertEqual(self.client.get("/static/js/app.js").status_code, 200)
        self.assertEqual(self.client.get("/static/css/style.css").status_code, 200)


class WorkflowTests(unittest.TestCase):
    def test_routing_evidence_and_retry_boundaries(self):
        self.assertEqual(workflow.route_after_router({"source_used": "kb"}), "retrieve_kb")
        self.assertEqual(
            workflow.route_after_router({"source_used": "direct"}), "direct_answer"
        )
        self.assertEqual(workflow.after_kb({"kb_grade": "good"}), "generate_from_kb")
        self.assertEqual(workflow.after_kb({"kb_grade": "weak"}), "search_web")
        self.assertEqual(
            workflow.after_web({"web_grade": "good"}), "generate_from_web"
        )
        with patch.object(workflow.settings, "max_retries", 1):
            self.assertEqual(
                workflow.after_web({"web_grade": "weak", "retry_count": 0}),
                "rewrite_query",
            )
            self.assertEqual(
                workflow.after_web({"web_grade": "weak", "retry_count": 1}),
                "insufficient",
            )

    def test_web_search_uses_configured_auth_and_returns_citations(self):
        response = Mock()
        response.json.return_value = {
            "answer": "Vendor status is operational.",
            "results": [
                {
                    "title": "Status page",
                    "url": "https://status.example.com",
                    "content": "All systems operational.",
                }
            ],
        }
        with (
            patch.object(workflow.settings, "tavily_api_key", "test-tavily-key"),
            patch.object(workflow.requests, "post", return_value=response) as post,
        ):
            result = workflow.search_web(
                {"current_query": "vendor status", "trace": []}
            )
        self.assertEqual(
            post.call_args.kwargs["headers"]["Authorization"],
            "Bearer test-tavily-key",
        )
        self.assertEqual(result["citations"][0]["url"], "https://status.example.com")

    def test_web_search_handles_missing_key_and_http_errors(self):
        state = {"current_query": "vendor status", "trace": []}
        with (
            patch.object(workflow.settings, "tavily_api_key", ""),
            patch.object(workflow.requests, "post") as post,
        ):
            with self.assertRaisesRegex(RuntimeError, "TAVILY_API_KEY is missing"):
                workflow.search_web(state)
            post.assert_not_called()

        response = Mock()
        response.raise_for_status.side_effect = RuntimeError("HTTP failure")
        with (
            patch.object(workflow.settings, "tavily_api_key", "test-tavily-key"),
            patch.object(workflow.requests, "post", return_value=response),
        ):
            with self.assertRaisesRegex(RuntimeError, "HTTP failure"):
                workflow.search_web(state)


if __name__ == "__main__":
    unittest.main()
