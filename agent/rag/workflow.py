import logging
from time import perf_counter
from typing import Literal

import requests
from groq import RateLimitError
from langchain_groq import ChatGroq
from langgraph.graph import StateGraph, START, END
from agent.core.config import get_settings
from agent.rag.state import AgentState, RouteDecision, EvidenceGrade
from agent.rag.vectorstore import get_retriever

logger = logging.getLogger(__name__)
settings = get_settings()

__llm = None
__fallback_llm = None


def llm():
    global __llm
    if __llm is None:
        if not settings.groq_api_key:
            raise RuntimeError("GROQ_API_KEY is missing")
        __llm = ChatGroq(
            model=settings.groq_model,
            temperature=0.2,
            api_key=settings.groq_api_key,
            timeout=settings.llm_timeout_seconds,
            max_retries=0,
        )
    return __llm


def fallback_llm():
    global __fallback_llm
    fallback_api_key = settings.groq_fallback_api_key.strip()
    if not fallback_api_key or fallback_api_key == settings.groq_api_key.strip():
        return None
    if __fallback_llm is None:
        __fallback_llm = ChatGroq(
            model=settings.groq_model,
            temperature=0.2,
            api_key=fallback_api_key,
            timeout=settings.llm_timeout_seconds,
            max_retries=0,
        )
    return __fallback_llm


def with_rate_limit_fallback(primary, backup=None):
    if backup is None:
        return primary
    return primary.with_fallbacks(
        [backup], exceptions_to_handle=(RateLimitError,)
    )


def llm_with_fallback():
    return with_rate_limit_fallback(llm(), fallback_llm())


def structured_llm(schema, method: str):
    primary = llm().with_structured_output(schema, method=method)
    backup = fallback_llm()
    if backup is None:
        return primary
    return with_rate_limit_fallback(
        primary, backup.with_structured_output(schema, method=method)
    )


def add_trace(state: AgentState, message: str):
    return [*state.get("trace", []), message]


def source_label(source: object) -> str:
    normalized = str(source or "Private KB").replace("\\", "/")
    return normalized.rsplit("/", 1)[-1] or "Private KB"


def route_question(state: AgentState):
    router = structured_llm(RouteDecision, method="json_mode")
    decision = router.invoke(f"""
        You route messages for an enterprise IT support assistant.
        Use kb for questions about company IT policies, VPN, password reset, MFA, laptop setup,
        software access, security, email, devices, troubleshooting, or technology support.
        Use direct only for greetings, thanks, or casual chat that needs no company knowledge.
        Question: {state['question']}
        Return valid JSON like {{"route":"kb"}}.
    """)
    return {
        "source_used": decision.route,
        "trace": add_trace(state, f"Router → {decision.route.upper()}"),
    }


def route_after_router(state: AgentState) -> Literal["retrieve_kb", "direct_answer"]:
    return "retrieve_kb" if state["source_used"] == "kb" else "direct_answer"


def retrieve_kb(state: AgentState):
    docs = get_retriever().invoke(state["current_query"])
    return {
        "kb_docs": docs,
        "trace": add_trace(state, f"Private KB retrieval → {len(docs)} chunks"),
    }


def grade_kb(state: AgentState):
    grader = structured_llm(EvidenceGrade, method="json_mode")
    context = "\n\n".join(
        f"Source: {d.metadata.get('source','unknown')}\n{d.page_content}"
        for d in state["kb_docs"]
    )
    grade = grader.invoke(f"""
        You grade evidence for an enterprise IT support assistant.
        Question: {state['question']}
        Private company KB evidence:\n{context}
        Return good only if the evidence is sufficient to answer confidently and specifically.
        Otherwise return weak. JSON: {{"grade":"good"}} or {{"grade":"weak"}}.
    """)
    return {
        "kb_grade": grade.grade,
        "trace": add_trace(state, f"KB evidence grade → {grade.grade.upper()}"),
    }


def after_kb(state: AgentState) -> Literal["generate_from_kb", "search_web"]:
    return "generate_from_kb" if state["kb_grade"] == "good" else "search_web"


def search_web(state: AgentState):
    if not settings.tavily_api_key:
        raise RuntimeError("TAVILY_API_KEY is missing")
    response = requests.post(
        "https://api.tavily.com/search",
        headers={"Authorization": f"Bearer {settings.tavily_api_key}"},
        json={
            "query": state["current_query"],
            "max_results": 5,
            "search_depth": "fast",
            "topic": "general",
            "include_answer": True,
            "include_raw_content": False,
        },
        timeout=settings.tavily_timeout_seconds,
    )
    response.raise_for_status()
    result = response.json()
    lines, citations = [], []
    if isinstance(result, dict):
        if result.get("answer"):
            lines.append("Search answer: " + result["answer"])
        for item in result.get("results", []):
            title, url, content = (
                item.get("title", ""),
                item.get("url", ""),
                item.get("content", ""),
            )
            lines.append(f"Title: {title}\nURL: {url}\nContent: {content}")
            citations.append({"title": title or url, "url": url, "type": "web"})
    else:
        lines.append(str(result))
    return {
        "web_results": "\n\n".join(lines),
        "citations": citations,
        "source_used": "web",
        "trace": add_trace(state, "Web fallback → Tavily search"),
    }


def grade_web(state: AgentState):
    grader = structured_llm(EvidenceGrade, method="json_mode")
    grade = grader.invoke(f"""
        Question: {state['question']}
        Web evidence:\n{state['web_results']}
        Return good if the evidence is sufficient and directly relevant; otherwise weak.
        Return valid JSON like {{"grade":"good"}}.
    """)
    return {
        "web_grade": grade.grade,
        "trace": add_trace(state, f"Web evidence grade → {grade.grade.upper()}"),
    }


def after_web(
    state: AgentState,
) -> Literal["generate_from_web", "rewrite_query", "insufficient"]:
    if state["web_grade"] == "good":
        return "generate_from_web"
    if state["retry_count"] < settings.max_retries:
        return "rewrite_query"
    return "insufficient"


def rewrite_query(state: AgentState):
    rewritten = llm_with_fallback().invoke(f"""
        Rewrite this IT support question for better private knowledge retrieval and vendor web search.
        Preserve intent, add useful technical keywords, do not answer, return only the query.
        Question: {state['question']}
    """).content.strip()
    return {
        "current_query": rewritten,
        "retry_count": state["retry_count"] + 1,
        "trace": add_trace(state, f"Query rewrite → {rewritten}"),
    }


def generate_from_kb(state: AgentState):
    context = "\n\n".join(
        f"[Source: {source_label(d.metadata.get('source'))}]\n{d.page_content}"
        for d in state["kb_docs"]
    )
    answer = llm_with_fallback().invoke(f"""
        You are an enterprise IT support copilot. Answer ONLY from the private company KB below.
        Be concise, actionable, and safe. If steps are present, present them clearly.
        Do not invent policy details. Mention that the answer is based on the company's private knowledge base.
        Question: {state['question']}\n\nPrivate KB:\n{context}
    """).content
    citations = []
    seen = set()
    for d in state["kb_docs"]:
        src = source_label(d.metadata.get("source"))
        if src not in seen:
            seen.add(src)
            citations.append({"title": src, "url": "", "type": "private_kb"})
    return {
        "answer": answer,
        "source_used": "private_kb",
        "citations": citations,
        "trace": add_trace(state, "Answer generation → PRIVATE KB"),
    }


def generate_from_web(state: AgentState):
    answer = llm_with_fallback().invoke(f"""
    You are an enterprise IT support copilot. The private company KB was insufficient.
    Answer ONLY from the web evidence below. Clearly say this is external web information and may need IT validation before changing company-managed systems.
    Question: {state['question']}\n\nWeb evidence:\n{state['web_results']}
    """).content
    return {
        "answer": answer,
        "source_used": "web_search",
        "trace": add_trace(state, "Answer generation → WEB SEARCH"),
    }


def direct_answer(state: AgentState):
    answer = (
        llm_with_fallback().invoke(
            f"Respond briefly and naturally to: {state['question']}"
        ).content
    )
    return {
        "answer": answer,
        "source_used": "direct",
        "trace": add_trace(state, "Direct response → no retrieval"),
    }


def insufficient(state: AgentState):
    return {
        "answer": "I couldn't find enough reliable evidence in the company knowledge base or external search to answer confidently. Please contact the IT help desk or provide more details.",
        "source_used": "insufficient_evidence",
        "trace": add_trace(state, "Stopped → insufficient reliable evidence"),
    }


def build_graph():
    graph = StateGraph(AgentState)
    for name, fn in {
        "route_question": route_question,
        "retrieve_kb": retrieve_kb,
        "grade_kb": grade_kb,
        "search_web": search_web,
        "grade_web": grade_web,
        "rewrite_query": rewrite_query,
        "generate_from_kb": generate_from_kb,
        "generate_from_web": generate_from_web,
        "direct_answer": direct_answer,
        "insufficient": insufficient,
    }.items():
        graph.add_node(name, fn)

    graph.add_edge(START, "route_question")
    graph.add_conditional_edges(
        "route_question",
        route_after_router,
        {"retrieve_kb": "retrieve_kb", "direct_answer": "direct_answer"},
    )
    graph.add_edge("retrieve_kb", "grade_kb")
    graph.add_conditional_edges(
        "grade_kb",
        after_kb,
        {"generate_from_kb": "generate_from_kb", "search_web": "search_web"},
    )
    graph.add_edge("search_web", "grade_web")
    graph.add_conditional_edges(
        "grade_web",
        after_web,
        {
            "generate_from_web": "generate_from_web",
            "rewrite_query": "rewrite_query",
            "insufficient": "insufficient",
        },
    )
    graph.add_edge("rewrite_query", "retrieve_kb")
    graph.add_edge("generate_from_kb", END)
    graph.add_edge("generate_from_web", END)
    graph.add_edge("direct_answer", END)
    graph.add_edge("insufficient", END)
    return graph.compile()


agent_graph = build_graph()


def ask(question: str):
    initial: AgentState = {
        "question": question,
        "current_query": question,
        "kb_docs": [],
        "web_results": "",
        "kb_grade": "",
        "web_grade": "",
        "answer": "",
        "source_used": "",
        "retry_count": 0,
        "trace": [],
        "citations": [],
    }
    started_at = perf_counter()
    try:
        return agent_graph.invoke(initial)
    finally:
        logger.info("Chat workflow finished in %.2f seconds", perf_counter() - started_at)