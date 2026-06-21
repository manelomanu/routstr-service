"""LangChain tool wrappers for AIRadar.

Requires: pip install airadar[langchain]

Usage::

    from airadar import AIRadarClient
    from airadar.langchain_tools import create_airadar_tools

    client = AIRadarClient(lightning=pay_invoice)
    tools = create_airadar_tools(client)

    # Drop tools into any LangChain / LangGraph / CrewAI agent
    agent = create_react_agent(llm, tools)
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .client import AIRadarClient


def create_airadar_tools(client: "AIRadarClient") -> list:
    """Return a list of LangChain ``BaseTool`` instances backed by *client*.

    Raises ``ImportError`` when ``langchain-core`` is not installed.
    """
    try:
        from langchain_core.tools import tool
    except ImportError:
        raise ImportError(
            "Install langchain support: pip install 'airadar[langchain]'"
        ) from None

    @tool
    def list_ai_providers(network: str = "") -> str:
        """List online AI inference providers on the AIRadar / Routstr network.
        Returns name, endpoint, online status and available models.
        Optionally filter by network (e.g. 'routstr', 'antseed')."""
        try:
            data = client.providers(network=network or None)
            providers = data.get("providers", [])
            if not providers:
                return "No providers found."
            lines = [f"Found {data.get('count', len(providers))} providers:"]
            for p in providers[:15]:
                st = p.get("status", {})
                models_n = len(p.get("models", []))
                lines.append(
                    f"- {p.get('name', '?')}: endpoint={p.get('endpoint', '?')}, "
                    f"online={st.get('online', '?')}, models={models_n}, "
                    f"latency_ms={p.get('response_ms', '?')}"
                )
            return "\n".join(lines)
        except Exception as e:
            return f"Error listing providers: {e}"

    @tool
    def get_free_providers() -> str:
        """Get the top 3 online AI providers — no payment required.
        Use this for a quick check of network availability."""
        try:
            data = client.free()
            providers = data.get("providers", [])
            if not providers:
                return "No providers currently online."
            return "\n".join(
                f"- {p.get('name')}: {p.get('endpoint')}"
                for p in providers
            )
        except Exception as e:
            return f"Error: {e}"

    @tool
    def check_agent_reputation(agent_id: str) -> str:
        """Check the reputation score (0–100) of an AI agent, wallet address,
        or Nostr pubkey on the AIRadar network. Returns score, label, and
        interaction breakdown."""
        try:
            data = client.reputation(agent_id)
            bd = data.get("breakdown", {})
            lines = [
                f"Agent: {agent_id}",
                f"Score: {data.get('score')}/100 ({data.get('label', '?')})",
                f"Paid interactions: {bd.get('paid_interactions', 0)}",
                f"Services used: {bd.get('services_used', 0)}",
                f"First seen: {bd.get('first_seen', '?')}",
            ]
            if data.get("timestamp_proof"):
                lines.append(f"Bitcoin proof: {data['timestamp_proof'].get('proof_url', '?')}")
            return "\n".join(lines)
        except Exception as e:
            return f"Error checking reputation for {agent_id!r}: {e}"

    @tool
    def get_reputation_leaderboard() -> str:
        """Return the top AI agents ranked by reputation score on the AIRadar network."""
        try:
            data = client.reputation_leaderboard()
            agents = data.get("leaderboard", [])
            if not agents:
                return "No agents in leaderboard yet."
            lines = [f"Top {len(agents)} agents:"]
            for i, a in enumerate(agents[:10], 1):
                lines.append(f"{i}. {a.get('id', '?')} — score={a.get('score')}/100, label={a.get('label', '?')}")
            return "\n".join(lines)
        except Exception as e:
            return f"Error: {e}"

    @tool
    def web_search(query: str, n: int = 5) -> str:
        """Search the web and return clean results with title, URL, and snippet.
        Use this to find up-to-date information. Requires payment."""
        try:
            data = client.search(query, n=n)
            results = data.get("results", [])
            if not results:
                return "No results found."
            parts = []
            for r in results:
                parts.append(f"**{r.get('title', '')}**\n{r.get('url', '')}\n{r.get('snippet', '')}")
            return "\n\n".join(parts)
        except Exception as e:
            return f"Search error: {e}"

    @tool
    def run_ai_inference(model: str, prompt: str, system_prompt: str = "") -> str:
        """Run AI inference through the AIRadar gateway (340+ models available).
        Specify the model ID (e.g. 'openai/gpt-4o', 'anthropic/claude-3-5-sonnet').
        Optionally provide a system prompt. Requires payment."""
        messages: list[dict] = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        messages.append({"role": "user", "content": prompt})
        try:
            data = client.chat(model, messages)
            choices = data.get("choices", [])
            if not choices:
                return "No response from model."
            return choices[0].get("message", {}).get("content", "")
        except Exception as e:
            return f"Inference error: {e}"

    @tool
    def list_gateway_models(modality: str = "") -> str:
        """List AI models available through the AIRadar gateway with pricing tiers.
        Optionally filter by modality (e.g. 'text', 'image', 'audio'). Free endpoint."""
        try:
            data = client.gateway_models()
            models = data.get("data", [])
            if modality:
                models = [m for m in models if modality.lower() in (m.get("modality") or "").lower()]
            if not models:
                return "No models found."
            lines = [f"{len(models)} models available:"]
            for m in models[:20]:
                lines.append(
                    f"- {m['id']} | {m.get('airadar_tier', '?')} tier | "
                    f"{m.get('airadar_price_sats', '?')} sats | {m.get('airadar_price_usdc', '?')}"
                )
            if len(models) > 20:
                lines.append(f"... and {len(models) - 20} more")
            return "\n".join(lines)
        except Exception as e:
            return f"Error: {e}"

    return [
        list_ai_providers,
        get_free_providers,
        check_agent_reputation,
        get_reputation_leaderboard,
        web_search,
        run_ai_inference,
        list_gateway_models,
    ]
