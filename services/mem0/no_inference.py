"""Conductor stores provenance-bearing text verbatim and never requests extraction."""
from mem0.llms.base import LLMBase


class VerbatimOnlyLLM(LLMBase):
    def generate_response(self, *args, **kwargs):
        raise RuntimeError("This deployment requires infer=false; text generation is disabled")
