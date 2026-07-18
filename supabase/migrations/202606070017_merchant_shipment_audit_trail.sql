-- Migration 017: merchant_shipment_audit_trail
-- Adds audit trail support for shipment status changes and decision tracking.

-- Add audit_trail JSONB column to merchant_shipments if not exists
ALTER TABLE public.merchant_shipments
ADD COLUMN IF NOT EXISTS audit_trail JSONB DEFAULT '[]'::jsonb;

-- Add column for decision metadata
ALTER TABLE public.merchant_shipments
ADD COLUMN IF NOT EXISTS decision_metadata JSONB;

-- Add index for audit queries
CREATE INDEX IF NOT EXISTS idx_merchant_shipments_audit_trail
  ON public.merchant_shipments USING GIN (audit_trail);

-- Create audit log table for detailed tracking
CREATE TABLE IF NOT EXISTS public.shipment_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id UUID NOT NULL REFERENCES public.merchant_shipments(id) ON DELETE CASCADE,
  merchant_id UUID NOT NULL,
  event_type TEXT NOT NULL, -- 'status_change', 'label_generated', 'print_requested', 'tracking_verified'
  previous_value TEXT,
  new_value TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT -- user/system identifier
);

-- Index for shipment audit queries
CREATE INDEX IF NOT EXISTS idx_shipment_audit_events_shipment_id
  ON public.shipment_audit_events (shipment_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_shipment_audit_events_merchant_id
  ON public.shipment_audit_events (merchant_id, created_at DESC);

-- Enable RLS
ALTER TABLE public.shipment_audit_events ENABLE ROW LEVEL SECURITY;

-- Service role can read/write all
CREATE POLICY "service_role_shipment_audit_all" ON public.shipment_audit_events
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Authenticated users can see audit events for their merchant's shipments
CREATE POLICY "users_can_view_own_shipment_audit" ON public.shipment_audit_events
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.merchant_shipments ms
      WHERE ms.id = shipment_audit_events.shipment_id
      AND ms.merchant_id IN (
        SELECT merchant_id FROM public.merchant_users
        WHERE user_id = auth.uid()
      )
    )
  );
