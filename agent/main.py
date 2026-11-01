import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from agent.api.routes import router
from agent.core.config import get_settings, BASE_DIR
from agent.core.logging import configure_logging
from agent.services.audit import init_db

configure_logging()
settings = get_settings()
init_db()


app = FastAPI(title=settings.app_name, version="1.0.0")

app.include_router(router)
app.mount(
    "/static", StaticFiles(directory=str(BASE_DIR / "ui" / "static")), name="static"
)
templates = Jinja2Templates(directory=str(BASE_DIR / "ui" / "templates"))


@app.get("/", response_class=HTMLResponse)
def home(request: Request):
    return templates.TemplateResponse(
        request, "index.html", {"app_name": settings.app_name}
    )


if __name__ == "__main__":
    uvicorn.run("agent.main:app", host="127.0.0.1", port=8080, reload=True)