import { Component, type ReactNode } from "react";
import { ScrollView, StyleSheet, Text } from "react-native";

type Props = {
  children: ReactNode;
};

type State = {
  error: Error | null;
};

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Runtime error</Text>
        <Text style={styles.message}>{this.state.error.message}</Text>
        <Text style={styles.stack}>{this.state.error.stack}</Text>
      </ScrollView>
    );
  }
}

const styles = StyleSheet.create({
  content: { gap: 12, padding: 18 },
  title: { color: "#8c1d18", fontSize: 22, fontWeight: "800" },
  message: { color: "#24292f", fontSize: 15, fontWeight: "700" },
  stack: { color: "#57606a", fontSize: 12 },
});
