-- Current Kie Market media mappings are process-reviewed but remain disabled
-- until an explicit release activation. Old speculative Kie media rows fail closed.
BEGIN;
UPDATE model_upstreams mu SET enabled=FALSE
FROM models m
WHERE mu.model_id=m.id AND mu.upstream_id='kie' AND m.type IN('image','video','audio');

UPDATE model_upstreams mu SET
 upstream_model_id='nano-banana-2',price_per_image=4.00,price_per_audio_sec=NULL,markup=1.2000,enabled=FALSE
FROM models m WHERE mu.model_id=m.id AND m.slug='nano-banana-2-kie' AND mu.upstream_id='kie';

UPDATE model_upstreams mu SET
 upstream_model_id='kling-3.0/video',price_per_image=35.00,price_per_audio_sec=NULL,markup=1.2000,enabled=FALSE
FROM models m WHERE mu.model_id=m.id AND m.slug='kling-3-0-kie' AND mu.upstream_id='kie';
COMMIT;
