def resolve(ctx, input):
    words = [part for part in input["text"].split() if part]
    return {"count": len(words)}
