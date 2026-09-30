# How a Slurp picture prompt is built

One picture, from post to image model. Code: `server/src/slp/features/media/slp-images-service.ts`
(`generateCreatorPostImage`, every post, Story, chat picture, commission and artwork goes through it).

## The steps

1. **The post writer (first call)** writes the caption and a `scene`: `setting`, `action`,
   `expression`, `outfit`, `visualDirection`, `wardrobeId`, and `subject`: a known character's name
   and series the way image sites tag it (`fubuki (one punch man)`), or null for an original
   character. The scene has no appearance field on purpose: the look is the same in every picture, so
   code adds it from stored data, and the writer cannot change a Creator's face or hair post to post.
2. **Code orders the scene** into a short draft (`modules/feed/slp-image-brief.ts`): action,
   expression, outfit, place, the visual detail, the camera, the spice level, and "the only person".
3. **The look** is the Creator's stored appearance (Stage appearance, else the card's Appearance
   field, else the reference block). Card clothes are removed; the scene decides the outfit.
4. **The name** (0.3.5): with "The image model knows this character" on (Creator settings › Images,
   on by default for a linked character or persona) and an open identity, the name leads the prompt,
   in front of the look: the writer's `subject` when it names the same character as the card or the
   page, else the card name. The writer's name is never used for somebody else, and never reaches the
   enhancer's scene text with the switch off. An image model that learned a known character draws them from the name far better than
   from any appearance text. A tag model (Pony, Illustrious, NoobAI, NovelAI or a Danbooru style
   profile) gets it as a lowercase tag, and a tag already in the Appearance field
   (`asuka_langley_soryu`, `makima \(chainsaw man\)`) counts as present, so it goes in once. Turn it
   off for an original character (the model never saw that name) or when the Appearance already has
   the character's tag under another spelling (Danbooru's `souryuu_asuka_langley`).
5. **The enhancer (second call, optional)**, "Enhance image prompts": a text model rewrites the draft
   into the image model's style. It gets the draft, the style guidance, and the character context:
   who this is (name and the start of the card, context only), the appearance (see below), image
   habits, and the content policy. Personality is context only and never reaches the image model.
6. **Final assembly in code**, on every path: the device words come out, the viewpoint goes back in,
   the look is added (see "How Slurp adds the look"), the name leads, the Creator's art style is
   applied, then the Engine style profile and the negative prompt.

## "How Slurp adds the look"

This choice only matters with the enhancer on, because only the enhancer can word the look itself:

- **The enhancer writes it in**: the enhancer gets the look and words it into the scene.
- **Slurp inserts it**: the enhancer never sees the look; code puts it at the top of the prompt.
- **Both**: the enhancer words it, and code adds the traits it missed.

With the enhancer off there is nobody to word it, so code always inserts it.

## Where to look when a picture is wrong

Every post's Deep details keep the run (`SlpDeepDetailsImageRun`): the template prompt, the
enhancer's input and output (and why it was rejected), the appearance source, the style profile, and
the final prompt that went to the image model.
