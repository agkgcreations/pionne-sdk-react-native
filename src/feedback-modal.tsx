// User Feedback Modal — drop-in RN component the user mounts at the root
// of their tree. Opens whenever Pionne.showFeedback() is called.
//
// Styling stays minimal/system: no NativeWind, no theme system. We use
// inline RN styles so the SDK has zero CSS-runtime dependency.

import * as React from 'react';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import {
  type FeedbackContext,
  type FeedbackPayload,
  onShowFeedback,
  sendFeedback,
} from './feedback';

interface PionneFeedbackModalProps {
  /** Provided by Pionne internals once init() has run — wire via Pionne.getFeedbackContext(). */
  context: FeedbackContext | null;
  /** Override any string in the UI. */
  labels?: Partial<{
    title: string;
    description: string;
    nameLabel: string;
    emailLabel: string;
    messageLabel: string;
    submit: string;
    cancel: string;
    success: string;
    failure: string;
  }>;
  /** Override the look. Defaults are dark-mode friendly. */
  primaryColor?: string;
  backgroundColor?: string;
  textColor?: string;
}

const DEFAULTS = {
  title: 'Send feedback',
  description: 'Tell us what happened. We read every report.',
  nameLabel: 'Your name (optional)',
  emailLabel: 'Email (optional)',
  messageLabel: 'What happened?',
  submit: 'Send',
  cancel: 'Cancel',
  success: 'Thanks — feedback received.',
  failure: 'Could not send. Try again later.',
};

export function PionneFeedbackModal({
  context,
  labels,
  primaryColor = '#7B61FF',
  backgroundColor = '#1A1A22',
  textColor = '#F5F5F7',
}: PionneFeedbackModalProps) {
  const L = { ...DEFAULTS, ...(labels ?? {}) };

  const [visible, setVisible] = useState(false);
  const [eventId, setEventId] = useState<number | string | undefined>();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<'idle' | 'ok' | 'err'>('idle');

  useEffect(() => {
    return onShowFeedback((opts) => {
      setEventId(opts.eventId);
      setName(opts.defaults?.name ?? '');
      setEmail(opts.defaults?.email ?? '');
      setMessage(opts.defaults?.message ?? '');
      setOutcome('idle');
      setVisible(true);
    });
  }, []);

  const reset = () => {
    setVisible(false);
    setName('');
    setEmail('');
    setMessage('');
    setEventId(undefined);
    setOutcome('idle');
    setSubmitting(false);
  };

  const submit = async () => {
    if (!context || !message.trim()) return;
    setSubmitting(true);
    const payload: FeedbackPayload = { message, name, email, eventId };
    const res = await sendFeedback(context, payload);
    setSubmitting(false);
    setOutcome(res.ok ? 'ok' : 'err');
    if (res.ok) setTimeout(reset, 1200);
  };

  const surface = { backgroundColor };
  const inputStyle = [styles.input, { color: textColor, borderColor: textColor + '33' }];

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={reset}
    >
      <KeyboardAvoidingView
        style={styles.backdrop}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={[styles.card, surface]}>
          <Text style={[styles.title, { color: textColor }]}>{L.title}</Text>
          <Text style={[styles.description, { color: textColor + 'AA' }]}>{L.description}</Text>

          <TextInput
            placeholder={L.nameLabel}
            placeholderTextColor={textColor + '66'}
            value={name}
            onChangeText={setName}
            style={inputStyle}
            editable={!submitting}
            autoCapitalize="words"
          />
          <TextInput
            placeholder={L.emailLabel}
            placeholderTextColor={textColor + '66'}
            value={email}
            onChangeText={setEmail}
            style={inputStyle}
            editable={!submitting}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
          />
          <TextInput
            placeholder={L.messageLabel}
            placeholderTextColor={textColor + '66'}
            value={message}
            onChangeText={setMessage}
            style={[inputStyle, styles.textArea]}
            editable={!submitting}
            multiline
            numberOfLines={4}
            textAlignVertical="top"
          />

          {outcome === 'ok' && (
            <Text style={[styles.outcome, { color: '#3DD68C' }]}>{L.success}</Text>
          )}
          {outcome === 'err' && (
            <Text style={[styles.outcome, { color: '#FF5C7A' }]}>{L.failure}</Text>
          )}

          <View style={styles.actions}>
            <Pressable
              onPress={reset}
              disabled={submitting}
              style={[styles.btn, styles.btnGhost, { borderColor: textColor + '33' }]}
            >
              <Text style={[styles.btnText, { color: textColor }]}>{L.cancel}</Text>
            </Pressable>
            <Pressable
              onPress={submit}
              disabled={submitting || !message.trim()}
              style={[
                styles.btn,
                {
                  backgroundColor: primaryColor,
                  opacity: !message.trim() || submitting ? 0.5 : 1,
                },
              ]}
            >
              {submitting ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={[styles.btnText, { color: '#fff' }]}>{L.submit}</Text>
              )}
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  card: {
    borderRadius: 16,
    padding: 20,
    gap: 12,
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
  },
  description: {
    fontSize: 13,
    marginBottom: 4,
  },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  textArea: {
    minHeight: 90,
    paddingTop: 10,
  },
  outcome: {
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
    marginTop: 4,
  },
  btn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
    minWidth: 90,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnGhost: {
    borderWidth: 1,
    backgroundColor: 'transparent',
  },
  btnText: {
    fontSize: 14,
    fontWeight: '600',
  },
});
